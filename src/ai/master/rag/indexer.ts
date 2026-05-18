import { createHash } from 'node:crypto';
import { chunkMarkdown, DEFAULT_CHUNKER_OPTIONS } from './chunker';
import type { Chunk, EmbeddedChunk } from './types';
import type { RagStore } from './store-memory';

const HASH_VERSION = 'v1'; // bump if chunker options change to invalidate caches

export function computeCorpusHash(handbookMd: string, loreMd: string): string {
  const h = createHash('sha256');
  h.update(HASH_VERSION);
  h.update(' handbook ');
  h.update(handbookMd);
  h.update(' lore ');
  h.update(loreMd);
  h.update(' opts ');
  h.update(JSON.stringify(DEFAULT_CHUNKER_OPTIONS));
  return h.digest('hex');
}

export interface RebuildInput {
  handbookMd: string;
  loreMd: string;
  store: RagStore;
  embedFn: (text: string) => Promise<number[]>;
  /** When true, re-embed even if the hash matches the store. */
  force?: boolean;
}

export interface RebuildResult {
  chunkCount: number;
  hash: string;
  skipped: boolean;
}

export async function rebuildIndex(input: RebuildInput): Promise<RebuildResult> {
  const hash = computeCorpusHash(input.handbookMd, input.loreMd);
  const existing = await input.store.currentHash();
  if (!input.force && existing === hash) {
    return { chunkCount: 0, hash, skipped: true };
  }
  const handbookChunks = chunkMarkdown('handbook', input.handbookMd);
  const loreChunks = chunkMarkdown('lore', input.loreMd);
  const allChunks: Chunk[] = [...handbookChunks, ...loreChunks];
  const embedded: EmbeddedChunk[] = [];
  for (const c of allChunks) {
    const embedding = await input.embedFn(`${c.sectionPath}\n\n${c.content}`);
    embedded.push({ ...c, embedding });
  }
  await input.store.replaceAll(hash, embedded);
  return { chunkCount: embedded.length, hash, skipped: false };
}
