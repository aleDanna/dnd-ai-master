import type { EmbedderConfig } from './types';
import { ollamaHeaders } from '@/lib/local-fetch';

export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  model: process.env.OLLAMA_EMBEDDER_MODEL ?? 'nomic-embed-text',
  // Bumped from 5s to 30s: on first call after a master-model load Ollama
  // can take 10-20s to bring the embedder into memory (especially when a
  // 20B+ master model already holds most of the VRAM). 30s is the right
  // balance between "tolerate cold start" and "fail fast on real outage".
  timeoutMs: Number(process.env.OLLAMA_EMBEDDER_TIMEOUT_MS ?? '30000'),
};

/**
 * keep_alive value passed to Ollama on every embedding request. Defaults to
 * 30 minutes so the embedder doesn't churn between turns. Set negative to
 * pin forever; set '0' to unload immediately (testing only).
 */
const EMBEDDER_KEEP_ALIVE = process.env.OLLAMA_EMBEDDER_KEEP_ALIVE ?? '30m';

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Embed a single text via Ollama. Throws on HTTP error or network failure
 * — callers decide whether to retry, fall back, or surface to the user.
 *
 * IMPORTANT for unified-memory Macs (M-series): if the master LLM is a
 * 20B+ model, Ollama may serialise model loads and the embedder cold-start
 * can spike to 10-20s. The 30s default timeout absorbs this; for it to
 * happen ONLY once (not every turn) you must also set
 *   OLLAMA_MAX_LOADED_MODELS=2
 * on the Ollama daemon so the embedder can stay warm alongside the master.
 */
export async function embed(text: string, config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<number[]> {
  const res = await fetch(`${config.baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: ollamaHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: config.model, prompt: text, keep_alive: EMBEDDER_KEEP_ALIVE }),
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
