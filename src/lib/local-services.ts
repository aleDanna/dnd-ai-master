import { XTTS_LANGUAGES } from './tts-voices';

/**
 * True when the current process is a local development environment.
 *
 * Returns true iff:
 *   - process.env.VERCEL is not set (Vercel sets this on every deployment,
 *     production AND preview), AND
 *   - process.env.NODE_ENV is not 'production' (production build / `next start`).
 *
 * `pnpm dev` → true. `pnpm start` → false. Any Vercel deployment → false.
 */
export function isLocalEnvironment(): boolean {
  return !process.env.VERCEL && process.env.NODE_ENV !== 'production';
}

/**
 * Minimal HTTP ping with a 2-second timeout. Returns true iff a GET request
 * to the given URL resolves with an HTTP 2xx within the timeout.
 *
 * Never throws — network errors, timeouts, and non-2xx all return false.
 * Used at Settings render to display ✓/✗ badges without breaking the page.
 */
export async function pingService(baseUrl: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
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

interface PiperVoiceEntry { id: string; language?: string; quality?: string }

/** Fetches the installed Piper voices from /v1/audio/voices (OpenAI-compat).
 *  Returns [] on any failure. */
export async function fetchPiperVoices(): Promise<ModelOption[]> {
  const base = process.env.PIPER_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/v1/audio/voices`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const voices = (await res.json()) as PiperVoiceEntry[];
    return voices.map((v) => ({
      slug: v.id,
      label: v.id,
      blurb: [v.language, v.quality].filter(Boolean).join(' · ') || 'piper',
    }));
  } catch {
    return [];
  }
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
interface DrawThingsModel { title: string; model_name: string }

/** Fetches the installed Stable Diffusion checkpoints from Draw Things via
 *  /sdapi/v1/sd-models. Returns slugs prefixed with `draw-things:` so the
 *  Settings dispatcher can route by prefix at request time. */
export async function fetchDrawThingsModels(): Promise<ModelOption[]> {
  const base = process.env.DRAW_THINGS_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/sdapi/v1/sd-models`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const models = (await res.json()) as DrawThingsModel[];
    return models.map((m) => ({
      slug: `draw-things:${m.model_name}`,
      label: m.title,
      blurb: 'draw-things · core-ml',
    }));
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
    });
    if (!res.ok) return [];
    const json = (await res.json()) as OllamaTagsResponse;
    const models = json.models ?? [];
    return models
      .filter((m) => matchesLlmWhitelist(m.name))
      .map((m) => ({
        slug: m.name,
        label: normalizeOllamaLabel(m.name),
        blurb: [m.details?.parameter_size, m.details?.quantization_level]
          .filter(Boolean)
          .join(' · ') || 'local',
      }));
  } catch {
    return [];
  }
}

// ── Aggregate status orchestrator ──────────────────────────────────────────

async function buildAiStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.OLLAMA_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.OLLAMA_BASE_URL!, '/api/tags');
  const models = reachable ? await fetchOllamaModels() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildPiperStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.PIPER_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.PIPER_BASE_URL!, '/v1/audio/voices');
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
    };
  }

  const [ai, piper, xtts, comfyui, drawThings] = await Promise.all([
    buildAiStatus(),
    buildPiperStatus(),
    buildXttsStatus(),
    buildComfyUIStatus(),
    buildDrawThingsStatus(),
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
  };
}
