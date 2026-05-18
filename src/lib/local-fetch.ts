/**
 * Shared HTTP helpers for calling local services (Ollama, Piper, Draw
 * Things) that may be either:
 *
 *  - true-local (dev machine, `OLLAMA_BASE_URL=http://localhost:11434` etc.),
 *    in which case no auth is needed — the daemons sit on loopback;
 *  - tunneled (Vercel deploy → Tailscale Funnel → Mac), in which case the
 *    public endpoint is gated by `scripts/tunnel-proxy.ts` requiring an
 *    `Authorization: Bearer $LOCAL_LLM_TOKEN` header on every request.
 *
 * `localServiceHeaders()` emits the header iff the token is present, so the
 * same call sites work in both regimes without branching.
 *
 * Note: a single shared token gates ALL local services through the tunnel.
 * Splitting per-service would be overkill — the threat model is "anyone who
 * finds the funnel URL can burn my GPU"; per-service tokens add bookkeeping
 * without changing that.
 */
export function localServiceHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = process.env.LOCAL_LLM_TOKEN;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** Back-compat alias kept for the existing Ollama call sites. New callers
 *  should import `localServiceHeaders` directly — the semantics are the
 *  same, the name just reflects that we now use this for TTS/image too. */
export const ollamaHeaders = localServiceHeaders;
