import { pgTable, serial, text, timestamp, customType, index } from 'drizzle-orm/pg-core';

/**
 * Plan E.2 — RAG chunk store backed by pgvector. One row per chunk produced
 * by the markdown chunker (handbook + lore). `embedding` is a 768-dim
 * `vector` produced by Ollama `nomic-embed-text`. `source_hash` is the
 * SHA-256 of the source file at index time so the indexer can detect
 * staleness without re-reading every chunk.
 */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
  toDriver(value) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value) {
    if (typeof value !== 'string') return [];
    return value.slice(1, -1).split(',').map(Number);
  },
});

export const ragChunks = pgTable(
  'rag_chunks',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),           // 'handbook' | 'lore'
    sectionPath: text('section_path').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 768 }).notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceHashIdx: index('rag_chunks_source_hash_idx').on(t.sourceHash),
  }),
);

export type RagChunkRow = typeof ragChunks.$inferSelect;
export type RagChunkInsert = typeof ragChunks.$inferInsert;
