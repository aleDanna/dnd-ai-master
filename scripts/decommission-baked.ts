#!/usr/bin/env tsx
/**
 * scripts/decommission-baked.ts — Phase 03-C operator script (REQ-033).
 * Removes the retired baked tier variants + the RAG embedder from Ollama.
 *
 * Run on the Mac Mini M4 (production host) AFTER:
 *   1. `pnpm migrate-stale-userprefs` has rewritten any stored
 *      `userPrefs.aiMasterModel` / `campaigns.settings.aiMasterModel`
 *      references away from the retired slugs (Pitfall 6 mitigation —
 *      otherwise the next turn for those rows fails with `ollama 404
 *      model not found`).
 *   2. The Phase 03-D bench (`pnpm bench-phase-03-m4`) PASSED — the
 *      bench compares vault-on-M4 against `dnd-master-plus` (regression
 *      baseline). Decommissioning the variants BEFORE the bench would
 *      lose the A/B reference (Pitfall 7).
 *
 * Default mode is INTERACTIVE — confirms each `ollama rm` with the
 * operator (type `yes`) before running. Flags:
 *   --yes       skip prompts (CI / automation)
 *   --dry-run   list what would be removed, do NOT actually remove
 *
 * SAFETY:
 *   - Lists installed models via `ollama list` before prompting; skips
 *     any model that is not installed (no spurious error from `ollama
 *     rm`).
 *   - PRESERVES `dnd-master-plus` (REQ-033 regression baseline) — it is
 *     NOT in MODELS_TO_REMOVE.
 *   - Refuses to run if `ollama list` itself fails (daemon down / not
 *     installed).
 *
 * Usage:
 *   pnpm decommission-baked              # interactive (default)
 *   pnpm decommission-baked --yes        # auto-confirm all removals
 *   pnpm decommission-baked --dry-run    # preview only, no removals
 *
 * See docs/operators/phase-03-cutover.md Step 9 for the full decommission
 * ceremony context.
 */
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';

/**
 * The retired tier variants + the RAG embedder. Order is the order in
 * which removal is offered to the operator. Per Decision 8 (REQ-033):
 *   - dnd-master-lite : llama3.2:3b base (~3GB)
 *   - dnd-master-max  : mistral-small3.2:24b base (~14GB)
 *   - dnd-master-max2 : qwen3:30b-a3b-instruct-2507 base (~18GB)
 *   - dnd-master-max3 : qwen3:30b-a3b base (~18GB)
 * Per Decision 7 (REQ-033 RAG-decommission):
 *   - nomic-embed-text : RAG embedder (~270MB)
 *
 * PRESERVED (NOT in this list):
 *   - dnd-master-plus : regression baseline (REQ-033)
 *   - qwen3:30b-a3b-instruct-2507-q4_K_M : production primary (REQ-030)
 *   - qwen3:30b-a3b-instruct-2507        : quality fallback (REQ-031)
 *   - mistral-small3.2:24b               : offline content tool (REQ-032)
 *
 * Exported so tests can assert the list against the Decision 8 contract
 * WITHOUT spawning the CLI.
 */
export const MODELS_TO_REMOVE: ReadonlyArray<{
  readonly name: string;
  readonly sizeNote: string;
}> = [
  { name: 'dnd-master-lite', sizeNote: '~3GB' },
  { name: 'dnd-master-max', sizeNote: '~14GB' },
  { name: 'dnd-master-max2', sizeNote: '~18GB' },
  { name: 'dnd-master-max3', sizeNote: '~18GB' },
  { name: 'nomic-embed-text', sizeNote: '~270MB' },
];

interface Args {
  yes: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): Args {
  const out: Args = { yes: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  pnpm decommission-baked              # interactive (default)');
  console.log('  pnpm decommission-baked --yes        # auto-confirm all removals');
  console.log('  pnpm decommission-baked --dry-run    # preview only, no removals');
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Parse `ollama list` output to a Set of installed model names.
 * The default `ollama list` format is a fixed-width table:
 *
 *   NAME                              ID            SIZE      MODIFIED
 *   dnd-master-plus:latest            ab12cd34      11 GB     2 days ago
 *   qwen3:30b-a3b-instruct-2507       ef56ab78      19 GB     3 weeks ago
 *
 * We extract the first column (NAME) and strip the `:latest` suffix —
 * Ollama treats `<name>` and `<name>:latest` as the same model for `rm`
 * purposes, so normalizing makes the membership check robust against
 * whichever way the operator pulled the model.
 *
 * Exported so tests can drive parsing without spawning `ollama`.
 */
export function parseOllamaList(stdout: string): Set<string> {
  const installed = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Match the first whitespace-delimited token (the NAME column).
    const m = line.match(/^(\S+)/);
    if (!m) continue;
    const name = m[1]!;
    // Skip the header row.
    if (name === 'NAME') continue;
    installed.add(name.replace(/:latest$/, ''));
  }
  return installed;
}

function listInstalled(): Set<string> {
  let stdout: string;
  try {
    stdout = execSync('ollama list', { encoding: 'utf8' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[decommission-baked] cannot run \`ollama list\` — is the daemon running? (${msg})`,
    );
    process.exit(1);
  }
  return parseOllamaList(stdout);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  console.log('=== Phase 03-C decommission: retire baked variants + RAG embedder ===');
  if (args.dryRun) {
    console.log('=== DRY RUN — no models will be removed ===');
  }
  if (args.yes && !args.dryRun) {
    console.log('=== --yes — all confirmations auto-accepted ===');
  }
  console.log('');

  const installed = listInstalled();
  console.log(`[decommission-baked] ollama list reports ${installed.size} installed model(s)`);
  console.log('');

  let removed = 0;
  let skippedNotInstalled = 0;
  let skippedDeclined = 0;
  let failed = 0;

  for (const m of MODELS_TO_REMOVE) {
    if (!installed.has(m.name)) {
      console.log(`[skip] ${m.name} (${m.sizeNote}) — not installed`);
      skippedNotInstalled++;
      continue;
    }

    if (args.dryRun) {
      console.log(`[dry-run] would remove ${m.name} (${m.sizeNote})`);
      continue;
    }

    let confirmed = args.yes;
    if (!confirmed) {
      const answer = await ask(`Remove ${m.name} (${m.sizeNote})? [yes/no]: `);
      confirmed = answer.trim().toLowerCase() === 'yes';
    }

    if (!confirmed) {
      console.log(`[skip] ${m.name} — user declined`);
      skippedDeclined++;
      continue;
    }

    try {
      execSync(`ollama rm ${m.name}`, { encoding: 'utf8', stdio: 'inherit' });
      console.log(`[removed] ${m.name}`);
      removed++;
    } catch (e) {
      console.error(
        `[error] failed to remove ${m.name}: ${e instanceof Error ? e.message : e}`,
      );
      failed++;
    }
  }

  console.log('');
  console.log('=== decommission summary ===');
  console.log(`  removed:                ${removed}`);
  console.log(`  skipped (not installed): ${skippedNotInstalled}`);
  console.log(`  skipped (declined):      ${skippedDeclined}`);
  console.log(`  failed:                 ${failed}`);
  console.log('');
  console.log('Verify remaining: ollama list');
  console.log(
    'Expected remaining D&D models: dnd-master-plus (regression baseline), qwen3:30b-a3b-instruct-2507-q4_K_M (primary), qwen3:30b-a3b-instruct-2507 (fallback), mistral-small3.2:24b (offline content)',
  );

  process.exit(failed > 0 ? 1 : 0);
}

// Only run main() when invoked directly via `tsx` / `node`. When imported
// from tests we want the exports (MODELS_TO_REMOVE, parseArgs,
// parseOllamaList) but NOT the side effect of executing ollama list.
//
// Vitest imports the module via the ESM loader so `import.meta.url` is
// the file URL; the CLI invocation also has `import.meta.url ===
// pathToFileURL(process.argv[1])`. The plan-B detection: only run when
// process.argv[1] resolves to this file. The `endsWith` check is loose
// (works for tsx, node, and any wrapper) and avoids the URL ↔ path
// conversion ceremony.
const invokedDirectly =
  process.argv[1]?.endsWith('decommission-baked.ts') ||
  process.argv[1]?.endsWith('decommission-baked.js');

if (invokedDirectly) {
  main().catch((e) => {
    console.error('[decommission-baked] fatal:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
