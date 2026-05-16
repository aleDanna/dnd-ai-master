import type { RetrievedChunk } from './types';
import type { RagStore } from './store-memory';

export interface RetrieveOptions {
  query: string;
  store: RagStore;
  embedFn: (text: string) => Promise<number[]>;
  /** How many chunks to return after dedupe. */
  k: number;
}

/**
 * Embed the query, fetch a slightly-larger nearest neighbour set than
 * needed (k*2), then dedupe by sectionPath so the final K chunks come
 * from K different sections — avoids returning three slices of the
 * same H2 when the source is densely related.
 *
 * Failures (embedder down, empty query, empty store) return [] so the
 * caller can fall through to "no RAG block" without ceremony.
 */
export async function retrieveRelevant(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const q = opts.query.trim();
  if (!q) return [];
  let queryVec: number[];
  try {
    queryVec = await opts.embedFn(q);
  } catch {
    return [];
  }
  const raw = await opts.store.query(queryVec, opts.k * 2);
  const seen = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const c of raw) {
    if (seen.has(c.sectionPath)) continue;
    seen.add(c.sectionPath);
    out.push(c);
    if (out.length >= opts.k) break;
  }
  return out;
}
