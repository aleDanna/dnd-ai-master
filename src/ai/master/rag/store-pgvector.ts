import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ragChunks } from '@/db/schema/rag-chunks';
import type { RetrievedChunk } from './types';
import type { RagStore } from './store-memory';

/**
 * Postgres-backed store. The single-row replacement strategy (DELETE+INSERT
 * in a transaction) is fine for our corpus size (~250-500 chunks); a more
 * granular upsert would be premature optimisation.
 */
export function createPgvectorStore(): RagStore {
  return {
    async replaceAll(sourceHash, next) {
      await db.transaction(async (tx) => {
        await tx.delete(ragChunks);
        if (next.length === 0) return;
        // Insert in batches of 100 to keep the parameter count under
        // Postgres' default 65535 limit (each row uses ~6 params).
        const BATCH = 100;
        for (let i = 0; i < next.length; i += BATCH) {
          const slice = next.slice(i, i + BATCH).map((c) => ({
            source: c.source,
            sectionPath: c.sectionPath,
            content: c.content,
            embedding: c.embedding,
            sourceHash,
          }));
          await tx.insert(ragChunks).values(slice);
        }
      });
    },
    async query(queryEmbedding, k) {
      // pgvector's `<=>` operator returns cosine distance when the column
      // uses vector_cosine_ops. We pass the array as a literal and bind k.
      const vec = `[${queryEmbedding.join(',')}]`;
      const rows = await db.execute<{
        source: string;
        section_path: string;
        content: string;
        distance: number;
      }>(sql`
        SELECT source, section_path, content,
               embedding <=> ${vec}::vector AS distance
        FROM rag_chunks
        ORDER BY embedding <=> ${vec}::vector
        LIMIT ${k}
      `);
      return rows.rows.map<RetrievedChunk>((r) => ({
        source: r.source as 'handbook' | 'lore',
        sectionPath: r.section_path,
        content: r.content,
        distance: Number(r.distance),
      }));
    },
    async currentHash() {
      const rows = await db.execute<{ source_hash: string }>(sql`
        SELECT source_hash FROM rag_chunks LIMIT 1
      `);
      return rows.rows[0]?.source_hash ?? null;
    },
  };
}
