/** Source corpus a chunk originated from. Extend if we ever RAG more files. */
export type ChunkSource = 'handbook' | 'lore';

/** A pre-embedding chunk produced by the chunker. */
export interface Chunk {
  source: ChunkSource;
  /** Heading breadcrumb, e.g. 'Pacing > Combat tempo'. */
  sectionPath: string;
  content: string;
}

/** A chunk plus its embedding vector, ready for the store. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** A chunk returned by a similarity query. */
export interface RetrievedChunk extends Chunk {
  /** Cosine distance, lower = more relevant. */
  distance: number;
}

/** Embedder runtime config. */
export interface EmbedderConfig {
  baseUrl: string;       // e.g. 'http://localhost:11434'
  model: string;         // default 'nomic-embed-text'
  timeoutMs: number;     // default 5000
}
