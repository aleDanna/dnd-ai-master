#!/usr/bin/env tsx
/**
 * One-shot, idempotent CLI that migrates the legacy
 * `data/master_handbook.md` + `data/master_world_lore.md` into the
 * per-H2 markdown vault layout under `data/vault/handbook/{craft,lore}/`.
 *
 * Also generates:
 *  - `data/vault/handbook/index.md` (TOC pointing at every generated H2 file)
 *  - `data/vault/tools/index.md` + 3 per-tool stubs (`read_vault_multi.md`,
 *    `list_vault.md`, `end_turn.md`) — the lenient-discovery surface
 *    documented in REQ-012.
 *  - `data/vault/handbook/{spells,monsters,items,rules,classes}/.gitkeep`
 *    — placeholders for Phase 02+ catalogs.
 *
 * Re-runs are byte-identical: each output file is read first and compared
 * against the proposed output; only differing files are written. Output
 * reports `[unchanged|written]` per file so dev can see deltas at a glance.
 *
 * Env override: `VAULT_MIGRATE_OUT=<dir>` redirects the output root
 * (used by `tests/scripts/migrate-handbook-to-vault.test.ts`).
 *
 * See:
 *   .planning/phases/01-vault-read-path/plans/05-migration-script.md
 *   .planning/REQUIREMENTS.md (REQ-001, REQ-002, REQ-012)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const HANDBOOK_SRC = resolve(process.cwd(), 'data/master_handbook.md');
const LORE_SRC = resolve(process.cwd(), 'data/master_world_lore.md');

/**
 * Resolve the output root lazily so tests can set `VAULT_MIGRATE_OUT`
 * AFTER importing this module (module-load resolution would freeze the
 * value before the test's `beforeAll` block runs).
 */
function resolveVaultOut(): string {
  return process.env.VAULT_MIGRATE_OUT
    ? resolve(process.env.VAULT_MIGRATE_OUT)
    : resolve(process.cwd(), 'data/vault');
}

type Category = 'craft' | 'lore';

interface H2Section {
  number: number;
  title: string;
  slug: string;
  body: string;
}

/**
 * Manual-slug overrides — keyed on the original H2 title. Produces cleaner
 * URLs than the auto-slug (e.g. "The Multiverse (Cosmology)" → "cosmology"
 * instead of "the-multiverse-cosmology"). Titles not in the map fall back
 * to the auto-slug.
 */
const MANUAL_SLUGS: Record<string, string> = {
  // craft (handbook)
  'Your Role': 'role',
  'Knowing the Player': 'knowing-the-player',
  'Pacing & Narration': 'pacing',
  'Resolving Outcomes': 'resolving-outcomes',
  'Social Interaction': 'social',
  'Exploration': 'exploration',
  'Combat': 'combat',
  'Improvising': 'improvising',
  'Death and Consequences': 'death',
  'Character Advancement': 'character-advancement',
  'NPCs': 'npcs',
  'Common Pitfalls (Avoid These)': 'common-pitfalls',
  // lore (world)
  'The Multiverse (Cosmology)': 'cosmology',
  'Magic in the World': 'magic',
  'Deities and Religion': 'deities',
  'Cultures, Factions, Settlements': 'cultures',
  'Campaign Frames': 'campaign-frames',
  'Common Tropes and Hooks': 'tropes',
  'Rewards and Gratification (CRITICAL)': 'rewards',
  'When the Player Asks About the World': 'world-questions',
};

const FUTURE_CATEGORIES: ReadonlyArray<string> = ['spells', 'monsters', 'items', 'rules', 'classes'];

function autoSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Parse H2 sections of the shape `## N. Title` out of a master markdown
 * file. Body extends from after the heading line to the next heading line
 * (or EOF). The H1 heading and any preamble before the first H2 are
 * intentionally dropped — the per-H2 files start with the H2 title rendered
 * as an H1.
 */
export function parseH2Sections(markdown: string): H2Section[] {
  const lines = markdown.split('\n');
  const headingRe = /^## (\d+)\. (.+)$/;
  const sections: H2Section[] = [];

  let current: { number: number; title: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    const match = line.match(headingRe);
    if (match) {
      if (current) {
        sections.push({
          number: current.number,
          title: current.title,
          slug: MANUAL_SLUGS[current.title] ?? autoSlug(current.title),
          body: trimTrailingBlankLines(current.bodyLines).join('\n'),
        });
      }
      current = { number: Number(match[1]), title: match[2]!, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    sections.push({
      number: current.number,
      title: current.title,
      slug: MANUAL_SLUGS[current.title] ?? autoSlug(current.title),
      body: trimTrailingBlankLines(current.bodyLines).join('\n'),
    });
  }
  return sections;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(0, end);
}

function escapeYamlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildSectionFile(section: H2Section, category: Category, sourceFile: string): string {
  return [
    '---',
    `id: ${section.slug}`,
    `category: ${category}`,
    `source: ${sourceFile}`,
    `h2_number: ${section.number}`,
    `h2_title: ${escapeYamlString(section.title)}`,
    '---',
    '',
    `# ${section.title}`,
    '',
    section.body,
    '',
  ].join('\n');
}

interface WriteOutcome {
  path: string;
  status: 'written' | 'unchanged';
}

function writeIfDifferent(absPath: string, content: string): WriteOutcome {
  if (existsSync(absPath)) {
    const existing = readFileSync(absPath, 'utf8');
    if (existing === content) {
      return { path: absPath, status: 'unchanged' };
    }
  }
  mkdirSync(resolve(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
  return { path: absPath, status: 'written' };
}

function buildHandbookIndex(craft: H2Section[], lore: H2Section[]): string {
  const lines: string[] = [
    '# Handbook Index',
    '',
    'Generated by `scripts/migrate-handbook-to-vault.ts`. Do not edit by hand — re-run the migration to regenerate.',
    '',
    '## Craft (DM technique)',
    '',
  ];
  for (const s of craft) lines.push(`- [${s.title}](./craft/${s.slug}.md)`);
  lines.push('');
  lines.push('## Lore (worldbuilding)');
  lines.push('');
  for (const s of lore) lines.push(`- [${s.title}](./lore/${s.slug}.md)`);
  lines.push('');
  lines.push('## Reserved (Phase 02+)');
  lines.push('');
  lines.push('- `./spells/<id>.md` — spell catalog (empty in Phase 01)');
  lines.push('- `./monsters/<id>.md` — monster catalog (empty in Phase 01)');
  lines.push('- `./items/<id>.md`');
  lines.push('- `./rules/<topic>.md`');
  lines.push('- `./classes/<class>.md`');
  lines.push('');
  return lines.join('\n');
}

const TOOLS_INDEX_CONTENT = [
  '# Available Tools',
  '',
  '| Tool | Purpose |',
  '|---|---|',
  '| `read_vault_multi` | Read N markdown files from the vault in ONE call (pass array of paths). |',
  '| `list_vault` | List immediate children of a vault directory. |',
  '| `end_turn` | Conclude the turn with a narrative response (optional — you may also return content directly). |',
  '',
].join('\n');

const READ_VAULT_MULTI_STUB = [
  '---',
  'tool: read_vault_multi',
  '---',
  '',
  '# read_vault_multi',
  '',
  'Read MANY markdown files in ONE call. Prefer this over multiple sequential reads.',
  '',
  '## Schema',
  '',
  '```json',
  '{',
  '  "name": "read_vault_multi",',
  '  "arguments": {',
  '    "paths": ["array of absolute vault paths, e.g. \'/handbook/spells/fireball.md\'"]',
  '  }',
  '}',
  '```',
  '',
  '## Example',
  '',
  '```json',
  '{ "paths": ["/handbook/spells/fireball.md", "/handbook/monsters/goblin.md"] }',
  '```',
  '',
  'Result is a single concatenated block per file, separated by `---`. Per-file errors (missing file, traversal attempt) appear inline so the batch never aborts.',
  '',
].join('\n');

const LIST_VAULT_STUB = [
  '---',
  'tool: list_vault',
  '---',
  '',
  '# list_vault',
  '',
  'List immediate children of a vault directory (one level — no recursive walk).',
  '',
  '## Schema',
  '',
  '```json',
  '{',
  '  "name": "list_vault",',
  '  "arguments": { "directory": "absolute vault directory, e.g. \'/handbook/spells\'" }',
  '}',
  '```',
  '',
  '## Example',
  '',
  '`{ "directory": "/handbook/craft" }` → `Children of /handbook/craft:` followed by `- role.md`, `- combat.md`, …',
  '',
].join('\n');

const END_TURN_STUB = [
  '---',
  'tool: end_turn',
  '---',
  '',
  '# end_turn',
  '',
  'Conclude the turn with a final narrative response.',
  '',
  '## Schema',
  '',
  '```json',
  '{',
  '  "name": "end_turn",',
  '  "arguments": { "response": "string — the final narrative for the player" }',
  '}',
  '```',
  '',
  '## Alternative terminator',
  '',
  'You may ALSO end the turn by returning normal content with no tool calls (`no_tool_calls + content`). Both forms are accepted by the server.',
  '',
].join('\n');

function migrate(): { written: number; unchanged: number } {
  const vaultOut = resolveVaultOut();
  const outcomes: WriteOutcome[] = [];

  // Per-H2 craft files
  const craftSections = parseH2Sections(readFileSync(HANDBOOK_SRC, 'utf8'));
  for (const section of craftSections) {
    const content = buildSectionFile(section, 'craft', 'master_handbook.md');
    outcomes.push(writeIfDifferent(join(vaultOut, 'handbook', 'craft', `${section.slug}.md`), content));
  }

  // Per-H2 lore files
  const loreSections = parseH2Sections(readFileSync(LORE_SRC, 'utf8'));
  for (const section of loreSections) {
    const content = buildSectionFile(section, 'lore', 'master_world_lore.md');
    outcomes.push(writeIfDifferent(join(vaultOut, 'handbook', 'lore', `${section.slug}.md`), content));
  }

  // handbook/index.md TOC
  outcomes.push(writeIfDifferent(join(vaultOut, 'handbook', 'index.md'), buildHandbookIndex(craftSections, loreSections)));

  // Future-category placeholders
  for (const cat of FUTURE_CATEGORIES) {
    outcomes.push(writeIfDifferent(join(vaultOut, 'handbook', cat, '.gitkeep'), ''));
  }

  // Tools surface
  outcomes.push(writeIfDifferent(join(vaultOut, 'tools', 'index.md'), TOOLS_INDEX_CONTENT));
  outcomes.push(writeIfDifferent(join(vaultOut, 'tools', 'read_vault_multi.md'), READ_VAULT_MULTI_STUB));
  outcomes.push(writeIfDifferent(join(vaultOut, 'tools', 'list_vault.md'), LIST_VAULT_STUB));
  outcomes.push(writeIfDifferent(join(vaultOut, 'tools', 'end_turn.md'), END_TURN_STUB));

  for (const o of outcomes) {
    console.log(`[${o.status}] ${o.path.replace(vaultOut, 'data/vault')}`);
  }
  const written = outcomes.filter((o) => o.status === 'written').length;
  const unchanged = outcomes.filter((o) => o.status === 'unchanged').length;
  return { written, unchanged };
}

export { migrate, MANUAL_SLUGS, FUTURE_CATEGORIES, resolveVaultOut };

// CLI entry — run when invoked as a script (not when imported by tests).
const isDirectInvocation = process.argv[1] && resolve(process.argv[1]).endsWith('migrate-handbook-to-vault.ts');
if (isDirectInvocation) {
  try {
    const summary = migrate();
    console.log(`\n${summary.written} files written, ${summary.unchanged} unchanged`);
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
