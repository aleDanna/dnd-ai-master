-- Plan E.2: RAG vector store. Extension might already exist (idempotent).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "rag_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"section_path" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rag_chunks_source_hash_idx" ON "rag_chunks" USING btree ("source_hash");

-- ivfflat index for cosine similarity queries. lists=100 is fine for <100k
-- chunks; tune up if the corpus grows.
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
