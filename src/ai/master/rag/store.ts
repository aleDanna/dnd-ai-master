import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { createMemoryStore, type RagStore } from './store-memory';
import { createPgvectorStore } from './store-pgvector';

let cached: { store: RagStore; backend: 'pgvector' | 'memory' } | null = null;

/**
 * Probe pgvector availability. Cached per-process — the first call
 * runs a tiny query, subsequent calls return the cached store.
 *
 * If pgvector is missing OR the rag_chunks table is missing (i.e. the
 * migration never ran on this DB), fall back to in-memory. The caller
 * will see the same RagStore interface either way.
 */
export async function getRagStore(): Promise<{ store: RagStore; backend: 'pgvector' | 'memory' }> {
  if (cached) return cached;
  try {
    await db.execute(sql`SELECT 1 FROM rag_chunks LIMIT 0`);
    cached = { store: createPgvectorStore(), backend: 'pgvector' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn('[rag] pgvector unavailable, falling back to in-memory store:', msg);
    cached = { store: createMemoryStore(), backend: 'memory' };
  }
  return cached;
}

/** Reset cache — only useful in tests. */
export function _resetRagStoreForTests(): void {
  cached = null;
}
