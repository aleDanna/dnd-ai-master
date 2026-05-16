/**
 * Plan D + E.1 — bake the master's static system prompt (now slim per E.1) into customised Ollama
 * models so per-turn requests can ship a tiny dynamic-only prompt.
 *
 * Usage:
 *   pnpm build-local-models                # build all installed bases
 *   pnpm build-local-models --base qwen3:30b
 *   pnpm build-local-models --force        # rebuild even if up-to-date
 *   pnpm build-local-models --dry-run      # write Modelfiles, skip `ollama create`
 *
 * See docs/superpowers/specs/2026-05-16-local-baked-models-design.md.
 */

import { loadDbEnv } from '../src/db/connection-url';
loadDbEnv();

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  MASTER_PROMPT_VERSION,
  MASTER_META_TOOLS_INSTRUCTION,
} from '../src/ai/master/system-prompt';
import {
  MASTER_SYSTEM_PROMPT_BASE_SLIM,
  MASTER_TOOL_CONTRACT_SLIM,
  MASTER_REWARDS_MANDATE_SLIM,
  MASTER_MEMORY_TOOL_RULE_SLIM,
  MASTER_HANDBOOK_ULTRA_SLIM,
} from '../src/ai/master/slim-prompts';
import { buildSrdContext } from '../src/ai/master/srd-context';
import { getBakedModelName, computeMasterPromptHash } from '../src/ai/master/baked-models';

/**
 * Models we explicitly EXCLUDE from auto-bake:
 *  - dnd-master-*: those ARE the output, not the input — don't re-bake.
 *  - *embed*: embedding models (nomic-embed-text, mxbai-embed, ...)
 *    have no chat template and ollama create would fail.
 *  - *whisper*, *bge-*, *reranker*: other utility models.
 *  - qwen3:14b, qwen3:8b: their context window is 40960 tokens, smaller
 *    than the ~45k-token combined prompt (baked SYSTEM ~28k + dynamic
 *    preamble ~3-5k + history + cushion). Ollama silently truncates
 *    keeping only the last 4 tokens of the prompt, producing garbled
 *    output that times out after 5 min. Verified empirically against
 *    a 14b baked variant: 45808 tok → "truncating input prompt
 *    limit=40960 keep=4 new=40960" in the Ollama server log → 500.
 *    Add more here if a future base also has too-small context.
 */
const TOO_SMALL_CONTEXT_BASES = new Set([
  'qwen3:14b',
  'qwen3:8b',
]);

function isBuildableBase(slug: string): boolean {
  if (slug.startsWith('dnd-master-')) return false;
  if (TOO_SMALL_CONTEXT_BASES.has(slug)) return false;
  const lower = slug.toLowerCase();
  if (lower.includes('embed')) return false;
  if (lower.includes('whisper')) return false;
  if (lower.includes('bge-')) return false;
  if (lower.includes('reranker')) return false;
  return true;
}

/**
 * Per-base Ollama PARAMETER overrides. Tuned for D&D narration:
 *  - num_ctx 65536: matches the runtime turn-route override; baking it
 *    here means we don't depend on the request specifying it.
 *  - temperature / top_p / repeat_penalty: starting points; profile if
 *    a specific base wants different defaults.
 *
 * NOTE: do NOT bake `num_predict` in the Modelfile — the runtime sends
 * a per-call override and an additional baked default has been observed
 * to interfere with tool-using turns on qwen3 chat templates.
 *
 * Override per-base by adding a key; otherwise DEFAULT_PARAMS apply.
 */
const DEFAULT_PARAMS: Record<string, string | number> = {
  num_ctx: 65536,
  temperature: 0.7,
  top_p: 0.9,
  repeat_penalty: 1.1,
};

const PER_BASE_PARAMS: Record<string, Record<string, string | number>> = {
  // qwen3 thinking mode benefits from a slightly lower temp on tool selection.
  'qwen3:30b': { temperature: 0.6 },
  'qwen3:30b-a3b': { temperature: 0.6 },
};

interface BuildArgs {
  force: boolean;
  base: string | null;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): BuildArgs {
  const out: BuildArgs = { force: false, base: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--force') out.force = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--base') out.base = argv[++i] ?? null;
    else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`pnpm build-local-models

Bake the master's static system prompt into customised Ollama models
so per-turn requests can ship a tiny dynamic-only prompt.

Options:
  --base <slug>   Only build for this base model (e.g. qwen3:30b).
  --force         Rebuild even if the existing variant is up-to-date.
  --dry-run       Write Modelfiles to .ollama/ but skip 'ollama create'.
  --help, -h      Print this help and exit.

Without --base, builds for every installed base in the curated list
that is also present in 'ollama list'.`);
}

/**
 * Shell out to ollama and parse the JSON response from `/api/tags`.
 * We use the HTTP API (default localhost:11434) rather than `ollama list`
 * to avoid parsing the human-readable table.
 */
async function listInstalledOllamaModels(): Promise<Set<string>> {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  let res: Response;
  try {
    res = await fetch(`${base}/api/tags`);
  } catch (e) {
    throw new Error(`Ollama unreachable at ${base} — is it running? (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) {
    throw new Error(`Ollama /api/tags returned ${res.status}`);
  }
  const data = (await res.json()) as { models?: { name: string }[] };
  return new Set((data.models ?? []).map((m) => m.name));
}

/**
 * Concatenate the 7 slim/compact static blocks for Plan E.1.
 * Vs the Plan B+C+D 9-block bake (~12.3K tok):
 *  - BASE/TOOL_CONTRACT/REWARDS/MEMORY_TOOL_RULE: full -> slim
 *  - HANDBOOK: full -> ultra-slim (full content moves to RAG in Plan E.2)
 *  - WORLD_LORE: dropped entirely (full content moves to RAG in Plan E.2)
 *  - ROLL_TRIGGERS: dropped (distributed across mode blocks added at turn time)
 *  - SRD compact: unchanged per design decision (keep intact for reliability)
 *
 * Result: ~4.4K tok baked, well within the ~7K tok ceiling.
 */
export async function buildStaticSystemContent(): Promise<string> {
  const srdContext = await buildSrdContext({ compact: true });
  const blocks: string[] = [
    MASTER_SYSTEM_PROMPT_BASE_SLIM,
    MASTER_TOOL_CONTRACT_SLIM,
    MASTER_META_TOOLS_INSTRUCTION,   // unchanged - required for local meta-tools
    MASTER_REWARDS_MANDATE_SLIM,
    MASTER_MEMORY_TOOL_RULE_SLIM,
    MASTER_HANDBOOK_ULTRA_SLIM,
    srdContext,
  ];
  return blocks.join('\n\n');
}

async function computeContentHash(systemContent: string): Promise<string> {
  // Delegate to the shared helper so build-time and runtime hashes
  // always agree — that's what the staleness check depends on.
  return computeMasterPromptHash(systemContent, MASTER_PROMPT_VERSION);
}

function buildModelfile(baseSlug: string, systemContent: string, contentHash: string): string {
  const params = { ...DEFAULT_PARAMS, ...(PER_BASE_PARAMS[baseSlug] ?? {}) };
  const paramLines = Object.entries(params)
    .map(([k, v]) => `PARAMETER ${k} ${v}`)
    .join('\n');

  // Use the triple-quote heredoc to avoid escaping every backtick / quote
  // / newline in the system content. Ollama's Modelfile parser supports
  // this; any literal `"""` in the content would conflict, but our static
  // prompts don't contain that sequence (verified at build time below).
  if (systemContent.includes('"""')) {
    throw new Error(
      'Static prompt content contains a literal `"""` which conflicts with the Modelfile heredoc delimiter. ' +
      'Either change the content or switch to a different escaping scheme.',
    );
  }

  return [
    `# Generated by scripts/build-local-models.ts on ${new Date().toISOString()}`,
    `# Source content hash: ${contentHash}`,
    `# Prompt version: ${MASTER_PROMPT_VERSION}`,
    `# Base model: ${baseSlug}`,
    `# Do NOT hand-edit — re-run 'pnpm build-local-models' instead.`,
    ``,
    `FROM ${baseSlug}`,
    ``,
    paramLines,
    ``,
    `SYSTEM """`,
    systemContent,
    `"""`,
    ``,
  ].join('\n');
}

/**
 * Read the existing baked variant's hash via `ollama show <name> --modelfile`.
 * Returns the stored hash, or null if the model doesn't exist / has no
 * recognisable hash comment.
 */
function readExistingBakedHash(bakedName: string): string | null {
  const proc = spawnSync('ollama', ['show', bakedName, '--modelfile'], { encoding: 'utf8' });
  if (proc.status !== 0) return null;
  const m = /^# Source content hash: ([a-f0-9]+)\s*$/m.exec(proc.stdout);
  return m ? m[1]! : null;
}

interface BuildResult {
  base: string;
  baked: string;
  status: 'built' | 'up-to-date' | 'skipped' | 'failed';
  reason?: string;
}

function buildOne(
  baseSlug: string,
  systemContent: string,
  contentHash: string,
  args: BuildArgs,
  outDir: string,
): BuildResult {
  const bakedName = getBakedModelName(baseSlug);
  if (!bakedName) {
    return { base: baseSlug, baked: '<n/a>', status: 'failed', reason: 'no ":" in base slug' };
  }

  if (!args.force) {
    const existing = readExistingBakedHash(bakedName);
    if (existing === contentHash) {
      return { base: baseSlug, baked: bakedName, status: 'up-to-date' };
    }
  }

  const modelfile = buildModelfile(baseSlug, systemContent, contentHash);
  const fileName = `${bakedName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.Modelfile`;
  const filePath = join(outDir, fileName);
  writeFileSync(filePath, modelfile, 'utf8');

  if (args.dryRun) {
    return { base: baseSlug, baked: bakedName, status: 'skipped', reason: `dry-run — wrote ${filePath}` };
  }

  const proc = spawnSync('ollama', ['create', bakedName, '-f', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (proc.status !== 0) {
    return { base: baseSlug, baked: bakedName, status: 'failed', reason: `ollama create exited ${proc.status}` };
  }
  return { base: baseSlug, baked: bakedName, status: 'built' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const installed = await listInstalledOllamaModels();
  console.log(`[build-local-models] found ${installed.size} installed models in Ollama`);

  // Pick target bases. With --base, build that one specifically.
  // Without --base, build a dnd-master variant for EVERY installed model
  // that isn't already a baked variant or a clearly-non-chat utility
  // (embeddings, rerankers, ...). If a model lacks tool-calling
  // capability the build will still succeed, but turns at runtime will
  // surface the error — the user picks which variant to keep.
  const targets = args.base
    ? [args.base]
    : [...installed].filter(isBuildableBase).sort();

  if (targets.length === 0) {
    if (args.base) {
      console.error(`[build-local-models] base model "${args.base}" not found in Ollama. Run \`ollama pull ${args.base}\` first.`);
    } else {
      console.error(`[build-local-models] no buildable base models found in Ollama.`);
      console.error(`[build-local-models] pull one with e.g. \`ollama pull qwen3:30b\` then re-run.`);
    }
    process.exit(1);
  }

  console.log(`[build-local-models] target bases (${targets.length}): ${targets.join(', ')}`);
  console.log(`[build-local-models] building static prompt content...`);
  const systemContent = await buildStaticSystemContent();
  const contentHash = await computeContentHash(systemContent);
  console.log(`[build-local-models] static prompt: ${systemContent.length.toLocaleString()} bytes, hash=${contentHash}, version=${MASTER_PROMPT_VERSION}`);

  // Persist generated Modelfiles into .ollama/ at repo root — gitignored.
  const outDir = join(process.cwd(), '.ollama');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const results: BuildResult[] = [];
  for (const base of targets) {
    if (!args.base && !installed.has(base)) {
      results.push({ base, baked: '<n/a>', status: 'skipped', reason: 'not installed' });
      continue;
    }
    console.log(`[build-local-models] ${base} → ${getBakedModelName(base)}...`);
    results.push(buildOne(base, systemContent, contentHash, args, outDir));
  }

  console.log('\n=== Build summary ===');
  for (const r of results) {
    const tag = r.status.padEnd(11);
    const reason = r.reason ? `  (${r.reason})` : '';
    console.log(`  [${tag}] ${r.base} → ${r.baked}${reason}`);
  }

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.error(`\n[build-local-models] ${failed.length} failure(s). Exiting with code 1.`);
    process.exit(1);
  }
  console.log(`\n[build-local-models] done. Restart your dev server and pick a "(optimized)" model in Settings.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[build-local-models] fatal:', e);
  process.exit(1);
});
