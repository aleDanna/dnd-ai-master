import { XTTS_LANGUAGES } from './tts-voices';
import { isBakedModel, getBakedBaseModel, TIER_LABELS } from '@/ai/master/baked-models';
import { pingEmbedder } from '@/ai/master/rag/embedder';
import { ollamaHeaders } from './local-fetch';

/**
 * True when the process can talk to a "local" provider stack. Two regimes:
 *
 *  1. Dev machine: VERCEL unset AND NODE_ENV != 'production' → always true.
 *     The user is on `pnpm dev`; we expose every local-engine surface so
 *     they can pick Ollama / Piper / ComfyUI etc. in Settings.
 *
 *  2. Cloud deploy (Vercel / `pnpm start`): true ONLY when the remote
 *     LLM tunnel is wired up — both `OLLAMA_BASE_URL` and `LOCAL_LLM_TOKEN`
 *     must be set. The token gates the public tunnel endpoint, so without
 *     it we refuse to call the remote Ollama (would leak access if the
 *     proxy ever ran without auth).
 */
export function isLocalEnvironment(): boolean {
  if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') return true;
  return !!process.env.OLLAMA_BASE_URL && !!process.env.LOCAL_LLM_TOKEN;
}

/**
 * Minimal HTTP ping with a 2-second timeout. Returns true iff a GET request
 * to the given URL resolves with an HTTP 2xx within the timeout.
 *
 * Never throws — network errors, timeouts, and non-2xx all return false.
 * Used at Settings render to display ✓/✗ badges without breaking the page.
 */
/** Probe timeout. 2s was fine for true-localhost daemons but is too tight
 *  for a Vercel function reaching a Tailscale Funnel: DNS + TLS handshake
 *  + funnel routing alone can burn 200-800ms, and cold starts add more.
 *  5s is the right balance — fail fast on real outages, tolerate the
 *  tunnel round-trip. Override via LOCAL_PROBE_TIMEOUT_MS. */
const PROBE_TIMEOUT_MS = Number(process.env.LOCAL_PROBE_TIMEOUT_MS ?? '5000');

export async function pingService(baseUrl: string, path: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
      ...(headers ? { headers } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Engine status returned to the Settings UI. `enabled` reflects whether the
 * relevant env var is set; `reachable` is the health check result; `models`
 * is the dynamic list of sub-models / voices / workflows.
 */
export interface EngineStatus {
  enabled: boolean;
  reachable: boolean;
  error?: string;
  models: ModelOption[];
}

/** Browser-safe model option, mirrors `ModelOption` from `src/lib/ai-models.ts`. */
export interface ModelOption {
  slug: string;
  label: string;
  blurb: string;
  /**
   * 'baked' for Plan D variants (dnd-master-*), 'raw' for everything
   * else. The Settings UI groups by this so users can find optimised
   * variants quickly. Optional — only meaningful for local LLM lists.
   */
  kind?: 'baked' | 'raw';
  /**
   * Surface a known limitation of this model (e.g. small 3B llamas
   * routinely lose the character snapshot in multi-block prompts).
   * When set, the Settings UI prefixes the option with ⚠ and renders
   * a helper line beneath the select. Free-form short string.
   */
  warning?: string;
}

/** Aggregate status passed from the settings server loader to the client. */
export interface LocalServicesStatus {
  isLocal: boolean;
  ai: EngineStatus;
  tts: {
    enabled: boolean;
    engines: { piper: EngineStatus; xtts: EngineStatus };
  };
  image: {
    enabled: boolean;
    engines: { comfyui: EngineStatus; drawThings: EngineStatus };
  };
  embedder: { reachable: boolean };
}

// LLM whitelist — phase 1 supports qwen3 and gpt-oss families, both from the
// official registry and from HuggingFace mirrors. Adding a new family is a
// one-line edit.
const LOCAL_LLM_PATTERNS: RegExp[] = [
  /^qwen3(:|$)/i,
  /^gpt-oss(:|$)/i,
  /^hf\.co\/.+\/qwen3[^/]*/i,
  /^hf\.co\/.+\/gpt-oss[^/]*/i,
];

export function matchesLlmWhitelist(name: string): boolean {
  return LOCAL_LLM_PATTERNS.some((p) => p.test(name));
}

/**
 * Pretty-print an Ollama model tag for the Settings dropdown. Plain registry
 * tags pass through; HuggingFace mirror paths get the `hf.co/` prefix
 * stripped, the `-GGUF` suffix removed, and the tag floated to a parenthesis.
 *
 *   qwen3:30b-a3b                            → qwen3:30b-a3b
 *   hf.co/unsloth/gpt-oss-20b-GGUF:F16       → unsloth/gpt-oss-20b (F16)
 */
export function normalizeOllamaLabel(name: string): string {
  if (!name.startsWith('hf.co/')) return name;
  const stripped = name.slice('hf.co/'.length);
  const colon = stripped.lastIndexOf(':');
  const path = colon >= 0 ? stripped.slice(0, colon) : stripped;
  const tag = colon >= 0 ? stripped.slice(colon + 1) : '';
  const clean = path.replace(/-GGUF$/i, '');
  return tag ? `${clean} (${tag})` : clean;
}

/** openedai-speech-min does NOT expose a `/v1/audio/voices` endpoint
 *  (404). It accepts a free-form `voice` string on POST /v1/audio/speech
 *  and maps voice names to Piper .onnx models via voice_to_speaker.yaml
 *  inside the container's config volume. The list below MUST stay in sync
 *  with that yaml: each slug here must have a matching `tts-1:` entry, and
 *  the referenced .onnx must exist under the mounted voices dir. Blurbs
 *  carry the underlying language so the Settings dropdown can distinguish
 *  English-only voices ('alloy', ...) from Italian voices ('paola', ...). */
const PIPER_OPENAI_COMPAT_VOICES: ReadonlyArray<{ slug: string; blurb: string }> = [
  { slug: 'alloy',    blurb: 'piper · english (libritts)' },
  { slug: 'echo',     blurb: 'piper · english (libritts)' },
  { slug: 'fable',    blurb: 'piper · english (northern UK)' },
  { slug: 'onyx',     blurb: 'piper · english (libritts)' },
  { slug: 'nova',     blurb: 'piper · english (libritts)' },
  { slug: 'shimmer',  blurb: 'piper · english (libritts)' },
  { slug: 'paola',    blurb: 'piper · italian (paola, medium)' },
  { slug: 'riccardo', blurb: 'piper · italian (riccardo, x-low)' },
];

export async function fetchPiperVoices(): Promise<ModelOption[]> {
  if (!process.env.PIPER_BASE_URL) return [];
  return PIPER_OPENAI_COMPAT_VOICES.map((v) => ({
    slug: v.slug,
    label: v.slug,
    blurb: v.blurb,
  }));
}

/** Returns the static XTTSv2 language catalog. Voice cloning is phase 2 — for
 *  now we expose one default speaker per supported language. */
export function listXttsVoices(): ModelOption[] {
  return XTTS_LANGUAGES.map((l) => ({
    slug: l.code,
    label: `${l.label} (default)`,
    blurb: 'xtts · neural',
  }));
}

interface OllamaTagsResponse {
  models?: {
    name: string;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
  }[];
}

/** Fetches the list of installed Ollama models from /api/tags, filters by the
 *  LLM whitelist, and shapes them as ModelOption[] for the Settings dropdown.
 *  Returns [] on any failure (env unset, network error, non-2xx). */
/** Fetches the *active* Draw Things checkpoint via /sdapi/v1/options.
 *  Draw Things does NOT expose `/sdapi/v1/sd-models` (returns 404) — only
 *  the single currently-loaded model name lives in `options.model`. Users
 *  switch model from inside the app. */
export async function fetchDrawThingsModels(): Promise<ModelOption[]> {
  const base = process.env.DRAW_THINGS_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/sdapi/v1/options`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const opts = (await res.json()) as { model?: string };
    if (!opts.model) return [];
    return [{
      slug: `draw-things:${opts.model}`,
      label: opts.model.replace(/\.ckpt$|\.safetensors$/i, ''),
      blurb: 'draw-things · active model',
    }];
  } catch {
    return [];
  }
}

/** Curated ComfyUI workflow list. Phase 1 ships only Flux Schnell; the slugs
 *  are stable, so future workflows just drop a new JSON in
 *  `src/sessions/image-providers/comfyui-workflows/` and add an entry here. */
const COMFYUI_WORKFLOWS: ModelOption[] = [
  { slug: 'comfyui:flux-schnell', label: 'Flux.1 Schnell', blurb: 'fast · 4 steps' },
];

export function listComfyUIWorkflows(): ModelOption[] {
  return [...COMFYUI_WORKFLOWS];
}

export async function fetchOllamaModels(): Promise<ModelOption[]> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
      headers: ollamaHeaders(),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as OllamaTagsResponse;
    const models = json.models ?? [];
    // Return EVERY installed model — no whitelist. The user picks freely; if
    // a model lacks tool-calling capability or fails on the master prompt,
    // we surface the failure at runtime rather than hide the option here.
    // matchesLlmWhitelist is still exported for callers that want curated
    // suggestions, but Settings shows the full list.
    return models.map((m) => {
      const baked = isBakedModel(m.name);
      const baseSlug = baked ? getBakedBaseModel(m.name) : null;
      // Tier-name baked variants get a curated display label so users
      // see "D&D Master Max — qwen3:30b-a3b" instead of the raw slug.
      // Legacy slug-derived baked variants fall back to the previous
      // "qwen3:30b (optimized)" format.
      const tierLabel = TIER_LABELS[m.name.replace(/:latest$/, '')];
      const label = tierLabel && baseSlug
        ? `${tierLabel} — ${baseSlug}`
        : baked && baseSlug
          ? `${baseSlug} (optimized)`
          : normalizeOllamaLabel(m.name);
      const blurb = baked
        ? 'baked · D&D master prompt embedded'
        : [m.details?.parameter_size, m.details?.quantization_level]
            .filter(Boolean)
            .join(' · ') || 'local';
      // Known small-model limitation: llama3.2:3b (and its baked variant)
      // drops the character snapshot when the prompt has many blocks.
      // Surface this in the UI so users picking a model see the caveat.
      const effectiveSlug = baseSlug ?? m.name;
      const warning = /llama3\.2.*3b/i.test(effectiveSlug)
        ? 'small model — may lose character context on long prompts; prefer Balance or Max'
        : undefined;
      return { slug: m.name, label, blurb, kind: baked ? 'baked' : 'raw', warning };
    });
  } catch {
    return [];
  }
}

// ── Aggregate status orchestrator ──────────────────────────────────────────

async function buildAiStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.OLLAMA_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const base = process.env.OLLAMA_BASE_URL!;
  const reachable = await pingService(base, '/api/tags', ollamaHeaders());
  if (!reachable) {
    // Diagnostic: re-issue the probe (without ok-gating) so the actual
    // failure mode shows up in Vercel function logs. Helps distinguish
    // "wrong URL" (404), "wrong token" (401), "Mac offline" (fetch error),
    // "timeout" (AbortError) without having to add a debug endpoint.
    try {
      const r = await fetch(`${base}/api/tags`, {
        headers: ollamaHeaders(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        cache: 'no-store',
      });
      const body = await r.text().catch(() => '');
      console.error('[ai-probe-fail] base=', base, 'hasToken=', !!process.env.LOCAL_LLM_TOKEN, 'status=', r.status, 'body[0:160]=', body.slice(0, 160));
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error('[ai-probe-fail] base=', base, 'hasToken=', !!process.env.LOCAL_LLM_TOKEN, 'err=', err);
    }
  }
  const models = reachable ? await fetchOllamaModels() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildPiperStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.PIPER_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  // openedai-speech-min exposes /health (200) for liveness; /v1/audio/voices is 404.
  const reachable = await pingService(process.env.PIPER_BASE_URL!, '/health');
  const models = reachable ? await fetchPiperVoices() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildXttsStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.XTTS_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.XTTS_BASE_URL!, '/speakers_list');
  // XTTS voices are static (hardcoded language list); shown regardless of reachability.
  const models = listXttsVoices();
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildComfyUIStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.COMFYUI_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.COMFYUI_BASE_URL!, '/system_stats');
  const models = listComfyUIWorkflows();
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildDrawThingsStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.DRAW_THINGS_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.DRAW_THINGS_BASE_URL!, '/sdapi/v1/options');
  const models = reachable ? await fetchDrawThingsModels() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

/** Server-side aggregator: runs all five health checks in parallel and
 *  returns the shape consumed by the Settings client component. Always
 *  resolves — never throws. */
export async function fetchLocalServicesStatus(): Promise<LocalServicesStatus> {
  if (!isLocalEnvironment()) {
    const empty: EngineStatus = { enabled: false, reachable: false, models: [] };
    return {
      isLocal: false,
      ai: empty,
      tts: { enabled: false, engines: { piper: empty, xtts: empty } },
      image: { enabled: false, engines: { comfyui: empty, drawThings: empty } },
      embedder: { reachable: false },
    };
  }

  const [ai, piper, xtts, comfyui, drawThings, embedderReachable] = await Promise.all([
    buildAiStatus(),
    buildPiperStatus(),
    buildXttsStatus(),
    buildComfyUIStatus(),
    buildDrawThingsStatus(),
    pingEmbedder().catch(() => false),
  ]);

  return {
    isLocal: true,
    ai,
    tts: {
      enabled: piper.enabled || xtts.enabled,
      engines: { piper, xtts },
    },
    image: {
      enabled: comfyui.enabled || drawThings.enabled,
      engines: { comfyui, drawThings },
    },
    embedder: { reachable: embedderReachable },
  };
}
