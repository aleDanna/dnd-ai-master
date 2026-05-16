import type { EmbedderConfig } from './types';

export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  model: process.env.OLLAMA_EMBEDDER_MODEL ?? 'nomic-embed-text',
  timeoutMs: Number(process.env.OLLAMA_EMBEDDER_TIMEOUT_MS ?? '5000'),
};

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Embed a single text via Ollama. Throws on HTTP error or network failure
 * — callers decide whether to retry, fall back, or surface to the user.
 */
export async function embed(text: string, config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<number[]> {
  const res = await fetch(`${config.baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: text }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedder HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as OllamaEmbeddingResponse;
  return json.embedding;
}

/**
 * Embed a batch sequentially. We do NOT parallelise because Ollama
 * serialises model calls anyway and concurrent requests just queue up
 * with worse latency. Sequential keeps the contract predictable.
 */
export async function embedBatch(texts: string[], config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {
    out.push(await embed(t, config));
  }
  return out;
}

/**
 * Health check — returns true if the embedder is reachable and produces
 * a non-empty vector. Used by the local-services status panel to surface
 * "Embedder: ✓/✗" in Settings.
 */
export async function pingEmbedder(config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<boolean> {
  try {
    const v = await embed('ping', config);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}
