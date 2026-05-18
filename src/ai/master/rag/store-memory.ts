import type { EmbeddedChunk, RetrievedChunk } from './types';

/**
 * Common interface every store must implement. pgvector and memory
 * both honor this so the retriever doesn't care which is active.
 */
export interface RagStore {
  /** Replace the entire store contents with a new index. Atomic per call. */
  replaceAll(sourceHash: string, chunks: EmbeddedChunk[]): Promise<void>;
  /** Top-K nearest chunks by cosine distance. */
  query(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]>;
  /** The hash of the index currently held, or null if empty. */
  currentHash(): Promise<string | null>;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s);
}

/** Cosine DISTANCE: 1 - cosine similarity. Range [0, 2], lower = closer. */
function cosineDistance(a: number[], b: number[]): number {
  const denom = norm(a) * norm(b);
  if (denom === 0) return 1;
  return 1 - dot(a, b) / denom;
}

/**
 * Lazy in-process store. Loses data on restart, which is fine: the
 * indexer rebuilds at boot when no pgvector is available. Cost is
 * ~10-30s for ~250 chunks on a warm Ollama instance.
 */
export function createMemoryStore(): RagStore {
  let chunks: EmbeddedChunk[] = [];
  let hash: string | null = null;
  return {
    async replaceAll(sourceHash, next) {
      chunks = next.slice();
      hash = sourceHash;
    },
    async query(q, k) {
      if (chunks.length === 0) return [];
      const scored = chunks.map<RetrievedChunk>((c) => ({
        source: c.source,
        sectionPath: c.sectionPath,
        content: c.content,
        distance: cosineDistance(q, c.embedding),
      }));
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, k);
    },
    async currentHash() {
      return hash;
    },
  };
}
