/**
 * Plan E.2 — Rebuild the RAG index from the on-disk handbook + lore.
 *
 * Usage:
 *   pnpm build-rag-index               # idempotent (skips if hash matches)
 *   pnpm build-rag-index --force       # rebuild even if up-to-date
 *
 * Requires:
 *   - Ollama running with `nomic-embed-text` pulled.
 *   - Postgres with pgvector (or accepts the in-memory fallback warning).
 */

import { loadDbEnv } from '../src/db/connection-url';
loadDbEnv();

import { getMasterHandbook, getMasterWorldLore } from '../src/ai/master/handbook';
import { rebuildIndex } from '../src/ai/master/rag/indexer';
import { getRagStore } from '../src/ai/master/rag/store';
import { embed, DEFAULT_EMBEDDER_CONFIG } from '../src/ai/master/rag/embedder';

interface Args { force: boolean; help: boolean; }

function parseArgs(argv: string[]): Args {
  const out: Args = { force: false, help: false };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`pnpm build-rag-index

Rebuild the RAG index from master_handbook.md + master_world_lore.md.

Options:
  --force         Re-embed even if the corpus hash matches.
  --help, -h      Print this help and exit.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('[rag-index] reading handbook + lore...');
  const handbookMd = getMasterHandbook({ compact: false });
  const loreMd = getMasterWorldLore({ compact: false });

  console.log('[rag-index] resolving store...');
  const { store, backend } = await getRagStore();
  console.log(`[rag-index] backend = ${backend}`);

  console.log(`[rag-index] embedder = ${DEFAULT_EMBEDDER_CONFIG.model} @ ${DEFAULT_EMBEDDER_CONFIG.baseUrl}`);

  const result = await rebuildIndex({
    handbookMd,
    loreMd,
    store,
    embedFn: (t) => embed(t),
    force: args.force,
  });

  if (result.skipped) {
    console.log(`[rag-index] up-to-date (hash=${result.hash.slice(0, 12)}). No work to do.`);
  } else {
    console.log(`[rag-index] indexed ${result.chunkCount} chunks (hash=${result.hash.slice(0, 12)}).`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[rag-index] fatal:', e);
  process.exit(1);
});
