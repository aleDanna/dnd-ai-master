-- Phase 03-C — drop pgvector RAG storage (REQ-033).
-- Hand-written to enforce the ordering required by 03-RESEARCH.md Pitfall 5:
--   1) DROP INDEX  rag_chunks_embedding_idx, rag_chunks_source_hash_idx
--   2) DROP TABLE  rag_chunks               (vector-typed column lives here)
--   3) ALTER TABLE ai_usage DROP COLUMN rag_chunk_count  (Wave 7 already removed
--                                              the column reference from the TS schema)
--   4) DROP EXTENSION vector               (MUST come last: dropping the extension
--                                              while any column still uses the
--                                              `vector` type fails with
--                                              `cannot drop extension because column
--                                              depends on it`)
--
-- `IF EXISTS` on every statement so the migration is idempotent and re-runnable.

DROP INDEX IF EXISTS "rag_chunks_embedding_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "rag_chunks_source_hash_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "rag_chunks";--> statement-breakpoint
ALTER TABLE "ai_usage" DROP COLUMN IF EXISTS "rag_chunk_count";--> statement-breakpoint
DROP EXTENSION IF EXISTS vector;
