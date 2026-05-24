import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Import the script's pure helpers + run it as a function via the env-redirect.
import { parseH2Sections, MANUAL_SLUGS, FUTURE_CATEGORIES } from '@/../scripts/migrate-handbook-to-vault';

const HEADER_REGEX = /^## (\d+)\. (.+)$/m;

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function listFilesRecursive(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(join(root, e.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

describe('parseH2Sections — pure parser', () => {
  it('extracts H2 sections of the form `## N. Title`', () => {
    const md = [
      '# Header',
      'preamble',
      '## 1. First',
      'first body',
      '',
      '## 2. Second',
      'second body',
      'more body',
    ].join('\n');
    const sections = parseH2Sections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ number: 1, title: 'First', body: 'first body' });
    expect(sections[1]).toMatchObject({ number: 2, title: 'Second', body: 'second body\nmore body' });
  });

  it('produces manual slug overrides where defined', () => {
    const md = '## 1. Your Role\nbody';
    const [s] = parseH2Sections(md);
    expect(s).toBeDefined();
    expect(s?.slug).toBe('role');
  });

  it('falls back to auto-slug for titles not in MANUAL_SLUGS', () => {
    const md = '## 1. Unknown Heading Title\nbody';
    const [s] = parseH2Sections(md);
    expect(s).toBeDefined();
    expect(s?.slug).toBe('unknown-heading-title');
  });

  it('drops preamble before the first H2', () => {
    const md = ['# Top', 'lots of preamble', 'more preamble', '## 1. Real', 'real body'].join('\n');
    const sections = parseH2Sections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toBe('real body');
  });
});

describe('migrate — full run + idempotency', () => {
  let tmpOut: string;
  let firstRunHashes: Record<string, string> = {};

  beforeAll(async () => {
    tmpOut = await mkdtemp(join(tmpdir(), 'vault-migrate-test-'));
    process.env.VAULT_MIGRATE_OUT = tmpOut;
    // Re-import the migrate function fresh so it picks up the env override.
    const mod = await import('@/../scripts/migrate-handbook-to-vault');
    mod.migrate();
    // Snapshot all output files' hashes for the idempotency check.
    const files = await listFilesRecursive(tmpOut);
    for (const f of files) firstRunHashes[f] = await hashFile(join(tmpOut, f));
  });

  afterAll(async () => {
    delete process.env.VAULT_MIGRATE_OUT;
    await rm(tmpOut, { recursive: true, force: true });
  });

  it('produces 12 craft files', async () => {
    const craft = await readdir(join(tmpOut, 'handbook', 'craft'));
    expect(craft.filter((f) => f.endsWith('.md'))).toHaveLength(12);
  });

  it('produces 8 lore files', async () => {
    const lore = await readdir(join(tmpOut, 'handbook', 'lore'));
    expect(lore.filter((f) => f.endsWith('.md'))).toHaveLength(8);
  });

  it('writes handbook/index.md with at least 20 generated-section links', async () => {
    const idx = await readFile(join(tmpOut, 'handbook', 'index.md'), 'utf8');
    const craftLinks = (idx.match(/\(\.\/craft\//g) ?? []).length;
    const loreLinks = (idx.match(/\(\.\/lore\//g) ?? []).length;
    expect(craftLinks + loreLinks).toBeGreaterThanOrEqual(20);
  });

  it('writes tools/index.md with exactly 3 tool rows', async () => {
    const content = await readFile(join(tmpOut, 'tools', 'index.md'), 'utf8');
    // Each tool row begins with a backticked name in a markdown table cell.
    const rowMatches = content.match(/^\| `[a-z_]+` \|/gm) ?? [];
    expect(rowMatches).toHaveLength(3);
  });

  it('emits per-tool stubs (read_vault_multi, list_vault, end_turn) — no apply_event', async () => {
    const toolsDir = await readdir(join(tmpOut, 'tools'));
    expect(new Set(toolsDir)).toEqual(new Set(['index.md', 'read_vault_multi.md', 'list_vault.md', 'end_turn.md']));
  });

  it('does not mention apply_event anywhere in tools/', async () => {
    const toolFiles = await readdir(join(tmpOut, 'tools'));
    for (const f of toolFiles) {
      const content = await readFile(join(tmpOut, 'tools', f), 'utf8');
      expect(content).not.toContain('apply_event');
    }
  });

  it('scaffolds future-category placeholders (spells/monsters/items/rules/classes)', async () => {
    for (const cat of FUTURE_CATEGORIES) {
      const stats = await stat(join(tmpOut, 'handbook', cat, '.gitkeep'));
      expect(stats.isFile()).toBe(true);
    }
  });

  it('frontmatter shape on craft/role.md', async () => {
    const content = await readFile(join(tmpOut, 'handbook', 'craft', 'role.md'), 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('id: role');
    expect(content).toContain('category: craft');
    expect(content).toContain('source: master_handbook.md');
    expect(content).toContain('h2_number: 1');
    expect(content).toContain('h2_title: "Your Role"');
    expect(content).toContain('\n# Your Role\n');
  });

  it('produced files use MANUAL_SLUGS naming where defined', async () => {
    // Every MANUAL_SLUGS entry should land as a file (under craft/ OR lore/).
    const craft = new Set(await readdir(join(tmpOut, 'handbook', 'craft')));
    const lore = new Set(await readdir(join(tmpOut, 'handbook', 'lore')));
    for (const slug of Object.values(MANUAL_SLUGS)) {
      const filename = `${slug}.md`;
      expect(craft.has(filename) || lore.has(filename)).toBe(true);
    }
  });

  it('re-run is byte-identical (idempotency)', async () => {
    // Run migrate again — should produce zero deltas.
    const mod = await import('@/../scripts/migrate-handbook-to-vault');
    mod.migrate();
    const files = await listFilesRecursive(tmpOut);
    for (const f of files) {
      const newHash = await hashFile(join(tmpOut, f));
      expect(newHash).toBe(firstRunHashes[f]);
    }
  });
});

describe('migrate — robustness', () => {
  it('source markdowns contain the expected number of H2 sections', async () => {
    const handbook = await readFile(join(process.cwd(), 'data/master_handbook.md'), 'utf8');
    const lore = await readFile(join(process.cwd(), 'data/master_world_lore.md'), 'utf8');
    const handbookH2s = (handbook.match(new RegExp(HEADER_REGEX.source, 'gm')) ?? []).length;
    const loreH2s = (lore.match(new RegExp(HEADER_REGEX.source, 'gm')) ?? []).length;
    expect(handbookH2s).toBe(12);
    expect(loreH2s).toBe(8);
  });
});
