# Local AI Provider — Design

**Status:** Draft · **Date:** 2026-05-16 · **Author:** alessio.danna.94@gmail.com

## Goal

Add `local` as a fourth value to the three existing AI provider selectors
(`aiProvider`, `ttsProvider`, `imageProvider`) so the app can run entirely
off-cloud when developing on the user's machine. The `local` value fans out to
a set of self-hosted backing services:

- **LLM** (master narration, wizard, language detection): **Ollama**, with a
  whitelist that accepts `qwen3:*`, `gpt-oss:*`, and the equivalent HuggingFace
  mirror tags (`hf.co/<org>/qwen3*`, `hf.co/<org>/gpt-oss*`).
- **TTS**: **Piper** (via the `openedai-speech-min` OpenAI-compatible Docker
  wrapper) or **XTTSv2** (via the `xtts-api-server` Python package).
- **Image generation**: **ComfyUI** with a Flux.1 Schnell workflow, or **Draw
  Things** (native macOS app with a Stable Diffusion-compatible HTTP API).

The `local` option appears in Settings only when `isLocalEnvironment()` returns
true AND at least one backing service of the relevant surface has its env var
set. Each surface (LLM / TTS / Image) is gated independently: users can mix
`aiProvider='local'` with `ttsProvider='openai'` and `imageProvider='gemini'`.

This phase does **not** remove or alter the existing cloud providers
(Anthropic / OpenAI / Gemini). Both stay available alongside `local`. A future
phase will deal with eliminating cloud dependencies once `local` proves stable.

## Non-goals

- ❌ Per-user backing service URLs (everyone using the local mode shares the
  env vars on that machine)
- ❌ Authentication or token forwarding to the backing services (they are
  assumed to be reachable from the Next.js dev server without auth — typical
  of localhost dev servers)
- ❌ Streaming responses from any backing service (`stream:false` is fine —
  the existing tool-loop and TTS button are round-trip-based)
- ❌ Ollama-specific runtime options surfaced in the UI (`num_ctx`,
  `temperature`, etc.) — `keep_alive` is set globally via env
- ❌ Live `/api/tags`-style polling from the client — model lists are fetched
  server-side at Settings page render only
- ❌ Production deploy of the backing services (this design adds integration
  only; the user runs the services manually)
- ❌ Removing cloud providers (`@anthropic-ai/sdk`, `openai`, `@google/genai`
  stay in `package.json` for now)
- ❌ ComfyUI workflows beyond Flux.1 Schnell in phase 1 (Flux Dev and SDXL
  Turbo are listed as stubs in the dropdown but not implemented)
- ❌ XTTS voice cloning UI (only built-in default speakers per language)
- ❌ Migration helpers for users who selected `local` and then lost access
  (they silently fall back to the env default)

## Architecture

A new `LocalProvider` class for each surface implements the existing provider
interface for that surface. No new abstractions are introduced — the existing
multi-provider pattern (Anthropic → OpenAI → Gemini → Local) is simply extended
with one more variant per surface. A shared module
`src/lib/local-services.ts` owns the environment detection, the health
checking, and the sub-model enumeration logic, so the three new providers
don't duplicate that code.

The whole feature is conceptually one provider with three sub-providers — but
mechanically it lives in three separate provider files (one in
`src/ai/provider/`, one in `src/ai/tts/`, one in `src/sessions/image-providers/`)
because that's how the codebase already splits these surfaces. Trying to
unify them into a single `LocalAIClient` class would break the established
pattern.

### Backing services and protocols

| Surface | Engine | Server | Port | Protocol |
|---|---|---|---|---|
| LLM | Ollama | `ollama serve` (native) | `11434` | REST native (`POST /api/chat`) |
| TTS | Piper | `openedai-speech-min` (Docker) | `8050` | OpenAI-compat (`POST /v1/audio/speech`) |
| TTS | XTTSv2 | `xtts-api-server` (native Python venv) | `8055` | Custom REST (`POST /tts_to_audio/`) |
| Image | ComfyUI | `python main.py` (native venv) | `8188` | Workflow REST (`POST /prompt`, poll `/history/{id}`) |
| Image | Draw Things | macOS app, HTTP server toggle | `7860` | SD-compatible (`POST /sdapi/v1/txt2img`) |

## File map

### New files

```
src/lib/
└── local-services.ts                    — isLocalEnvironment(), service health
                                            checks, sub-model enumerators (one
                                            per engine), label normalization,
                                            LocalServicesStatus type

src/ai/provider/
├── local.ts                             — LocalProvider implementing
│                                          MasterProvider, talks to Ollama via
│                                          ollama-adapter
└── ollama-adapter.ts                    — Anthropic↔Ollama shape conversion
                                            (system blocks, tool defs, messages,
                                            response, usage, stopReason)

src/sessions/image-providers/
├── comfyui.ts                           — workflow template injection +
│                                            queue + polling + GET /view
├── draw-things.ts                       — POST /sdapi/v1/txt2img +
│                                            base64 decode
└── comfyui-workflows/
    └── flux-schnell.json                — workflow JSON template with
                                            `{{PROMPT}}` placeholder

tests/lib/local-services.test.ts         — env detection, whitelist, label
                                            normalization, health checks
tests/ai/provider/local.test.ts          — provider with mocked fetch
tests/ai/provider/ollama-adapter.test.ts — round-trip adapter conversions
tests/ai/tts-local.test.ts               — piper + xtts synthesis branches
tests/sessions/image-providers/comfyui.test.ts
tests/sessions/image-providers/draw-things.test.ts
tests/api/campaign-settings-local.test.ts — PUT validation for 'local'
```

### Modified files

| File | Change |
|---|---|
| `src/ai/provider/index.ts` | `getProviderByName('local')` returns `LocalProvider`; reset hook |
| `src/ai/provider/types.ts` | `ProviderName` union extended with `'local'` |
| `src/ai/tts.ts` | `synthesizeSpeech` dispatches to `synthesizePiper` / `synthesizeXtts` when `provider==='local'`; new helpers inline (the file is single-module today, mirroring how the OpenAI/Gemini branches live there) |
| `src/lib/tts-voices.ts` | adds `'local'` to `TTS_PROVIDERS`; new `LOCAL_TTS_MODELS=['piper','xtts']`; new `XTTS_LANGUAGES` catalog; new helpers `voicesForLocal(model, runtimeList)`, `defaultVoiceForLocal(model)`; relaxes `isValidVoice*` for `'local'` (runtime-listed) |
| `src/sessions/image-providers/openai.ts` | (no change — kept for reference) |
| `src/sessions/image-providers/gemini.ts` | (no change) |
| `src/sessions/scene-image-job.ts` | extends provider dispatch with `'local'` branch that prefix-routes to `comfyui.ts` or `draw-things.ts` |
| `src/lib/preferences.ts` | `envDefaultProvider` accepts `'local'`; `getResolvedPreferences` AND `getCampaignSettings` downgrade stored `'local'` when `isLocalEnvironment()===false` or the matching backing env is unset; `validateSettingsPatch` accepts `'local'` and routes voice/model validation to local-aware helpers |
| `src/lib/ai-models.ts` | `ProviderName` and `ImageProviderName` unions extended with `'local'`; `modelsForProvider('local')` returns `[]` (runtime list passed separately); `isKnownProvider`/`isKnownImageProvider` accept `'local'`; `isKnownMasterModel`/`isKnownImageModel` for `'local'` accept any non-empty string ≤200 chars |
| `src/db/schema/users.ts` | `UserPreferences` type unions extended with `'local'` for all three provider fields (JSONB shape — no SQL migration) |
| `src/db/schema/campaigns.ts` | `CampaignSettings` type unions extended with `'local'` for the three provider fields (JSONB shape — no SQL migration) |
| `src/app/api/campaigns/[id]/settings/route.ts` | `'local'` rejected with 400 unless `isLocalEnvironment()` AND the relevant backing service env is set; model/voice slug validation relaxed for `'local'` (any non-empty string) |
| `src/app/api/preferences/route.ts` | same gating applied to per-user preferences PUT (kept narrow — only the few fields that are still per-user) |
| `src/app/(authed)/campaigns/[id]/settings/page.tsx` | server-side: calls `fetchLocalServicesStatus()`, passes `localServices` prop |
| `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` | new "Local" radio per surface (when enabled); new "Engine" selector for TTS/Image when `local`; dynamic model dropdown; status badges with ✓/✗ per engine |

### Files NOT touched

- `src/ai/master/tool-loop.ts` — provider-agnostic, works as-is
- `src/ai/master/language.ts`, `src/ai/wizard/loop.ts` — already dispatch via `getProviderByName`
- `src/app/api/sessions/[id]/turn/route.ts` — already provider-agnostic
- `src/sessions/scene-image-job.ts` — already dispatches by `imageProvider`
- Drizzle migrations — all three provider fields are JSONB keys in `users.preferences`

## Environment detection

A single predicate in `src/lib/local-services.ts`:

```ts
export function isLocalEnvironment(): boolean {
  // Vercel runtime always sets VERCEL=1 in production AND preview deployments.
  // NODE_ENV is 'production' both for `next start` and `next build`.
  return !process.env.VERCEL && process.env.NODE_ENV !== 'production';
}
```

`pnpm dev` → true. `pnpm start` (self-hosted prod) → false. Any Vercel
deployment → false. No env flag required to enable the local mode — it is
implicit in the development context.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `OLLAMA_BASE_URL` | (unset) | Ollama server URL (e.g. `http://localhost:11434`). When unset, `local` is hidden from `aiProvider` |
| `OLLAMA_KEEP_ALIVE` | `5m` | `keep_alive` parameter on each Ollama request to keep the model warm |
| `PIPER_BASE_URL` | (unset) | Piper server URL (e.g. `http://localhost:8050`). When unset, `piper:*` is hidden from `local` TTS engine choices |
| `XTTS_BASE_URL` | (unset) | xtts-api-server URL (e.g. `http://localhost:8055`). When unset, `xtts:*` is hidden |
| `COMFYUI_BASE_URL` | (unset) | ComfyUI URL (e.g. `http://localhost:8188`). When unset, `comfyui:*` is hidden |
| `COMFYUI_FLUX_WORKFLOW` | `flux-schnell` | Workflow JSON file name (in `comfyui-workflows/`) used when `imageModel` starts with `comfyui:` |
| `DRAW_THINGS_BASE_URL` | (unset) | Draw Things HTTP server URL (e.g. `http://localhost:7860`). When unset, `draw-things:*` is hidden |

Gating rules:

1. No env var set in a surface domain → `local` is **not rendered** in that selector.
2. At least one env var set and reachable → `local` is **rendered**, with the
   sub-engine selector showing only the engines whose env var is set.
3. Env var set but service unreachable → `local` is still rendered, with a
   `✗ unreachable` badge inline on the affected engine. UX choice: surface the
   misconfiguration rather than hide the option.

## Health check

Pure function, called server-side from the Settings page loader:

```ts
async function pingService(url: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    return res.ok;
  } catch { return false; }
}
```

Endpoints used for ping (chosen for speed and zero side-effects):

| Service | Ping endpoint |
|---|---|
| Ollama | `GET /api/tags` (also used to list models) |
| Piper | `GET /v1/audio/voices` (OpenAI-compat) |
| XTTSv2 | `GET /speakers_list` (xtts-api-server) |
| ComfyUI | `GET /system_stats` |
| Draw Things | `GET /sdapi/v1/options` |

All five pings run in parallel via `Promise.all`. Worst case the Settings
page render waits 2 seconds for the slowest hung service.

## LocalServicesStatus shape

```ts
type EngineStatus = {
  enabled: boolean;             // env var set
  reachable: boolean;           // health check ok
  error?: string;               // surfaced message when !reachable
  models: ModelOption[];        // sub-models / voices / workflows enumerated
};

type LocalServicesStatus = {
  isLocal: boolean;             // isLocalEnvironment()
  ai: EngineStatus;             // ai.models = Ollama models filtered by whitelist
  tts: {
    enabled: boolean;           // at least one TTS engine enabled
    engines: {
      piper: EngineStatus;
      xtts:  EngineStatus;
    };
  };
  image: {
    enabled: boolean;
    engines: {
      comfyui:    EngineStatus;
      drawThings: EngineStatus;
    };
  };
};

async function fetchLocalServicesStatus(): Promise<LocalServicesStatus>;
```

## LLM provider — Ollama

`LocalProvider` (in `src/ai/provider/local.ts`) implements `MasterProvider`
and talks to Ollama natively via `/api/chat`. The internal canonical
message/tool shape stays Anthropic-flavoured, with `ollama-adapter.ts`
performing the conversions.

```ts
const BASE_URL       = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const KEEP_ALIVE     = process.env.OLLAMA_KEEP_ALIVE ?? '5m';

class LocalProvider implements MasterProvider {
  readonly name = 'local' as const;

  async completeMessage(input) {
    const body = {
      model: input.model ?? (throws if undefined),
      messages: anthropicMessagesToOllama(input.systemBlocks, input.messages),
      tools: input.tools.map(anthropicToolToOllama),
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { num_predict: input.maxTokens ?? 4096 },
    };
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`ollama chat ${resp.status}: ${await resp.text()}`);
    const json = await resp.json() as OllamaChatResponse;
    return {
      contentBlocks: ollamaResponseToContentBlocks(json.message),
      stopReason:    ollamaDoneReasonToStopReason(json.done_reason),
      usage:         normalizeOllamaUsage(json),
    };
  }

  async detectLanguage(input)  { /* same shape, no tools */ }
  async proposeWizard(input)   { /* same shape, single tool, throws if no tool_call */ }
}
```

### Ollama adapter mapping

| Anthropic shape | Ollama shape |
|---|---|
| `system: [{type:'text', text, cache_control}, ...]` | merged into `messages[0]={role:'system', content: text1 + '\n\n' + text2 + ...}`; `cache_control` dropped (Ollama has no prompt-cache concept) |
| Tool def `{name, description, input_schema}` | `tools: [{type:'function', function:{name, description, parameters: input_schema}}]` |
| `assistant` message with `tool_use` blocks | `{role:'assistant', content: text, tool_calls: [{id, type:'function', function:{name, arguments: input}}]}`. Each `id` is a fresh `crypto.randomUUID()` generated at adapter time — Ollama doesn't validate it but the tool-loop's matching depends on it. |
| `user` message with multiple `tool_result` blocks | Fan-out to N `{role:'tool', content, tool_call_id}` messages |
| Response: `{message: {content, tool_calls?}, done_reason, prompt_eval_count, eval_count}` | `contentBlocks: [{type:'text', text}, {type:'tool_use', id, name, input}, ...]`; `stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other'` |
| Usage | `inputTokens: prompt_eval_count ?? 0`, `outputTokens: eval_count ?? 0`, `cacheReadTokens: 0`, `cacheCreationTokens: 0` |

Stop reason:
- `done_reason: 'stop'` + empty `tool_calls` → `'end_turn'`
- `done_reason: 'stop'` + non-empty `tool_calls` → `'tool_use'`
- `done_reason: 'length'` → `'max_tokens'`
- anything else → `'other'`

## TTS — Piper and XTTSv2

The existing single-file dispatcher in `src/ai/tts.ts` gains a third branch
in `synthesizeSpeech`. We do NOT refactor into a folder structure — the spec
2026-05-07 proposed that but the codebase chose the single-file extension
pattern instead, and we follow it:

```ts
export async function synthesizeSpeech(input: SynthesizeInput): Promise<SynthesizeOutput> {
  if (!input.text.trim()) throw new Error('tts: empty input');
  const provider = input.provider ?? 'openai';
  if (provider === 'local')  return synthesizeLocal(input);
  if (provider === 'gemini') return synthesizeGemini(input);
  return synthesizeOpenAI(input);
}

async function synthesizeLocal(input: SynthesizeInput): Promise<SynthesizeOutput> {
  // Engine identity lives in input.model ('piper' or 'xtts'), not in voice prefix.
  const engine = input.model;
  if (engine === 'piper') return synthesizePiper(input);
  if (engine === 'xtts')  return synthesizeXtts(input);
  throw new Error(`local tts: unknown engine "${engine}" (expected 'piper' or 'xtts')`);
}
```

The `(provider, model, voice)` triplet maps to local as:
- `provider: 'local'` — surfaces the local dispatcher
- `model: 'piper' | 'xtts'` — picks the engine
- `voice: <slug>` — bare voice id, namespace depends on engine
  - For Piper: a Piper voice name like `'en_US-amy-low'`
  - For XTTS: a language code like `'en'` or `'it'`

### Piper (via openedai-speech-min)

The chosen wrapper exposes an OpenAI-compatible endpoint, so the call shape
mirrors the existing `synthesizeOpenAI` function in `tts.ts`:

```ts
async function synthesizePiper(input: SynthesizeInput): Promise<SynthesizeOutput> {
  // input.voice is the bare voice id ('en_US-amy-low', etc) — engine
  // identity lives in input.model ('piper'). No prefix needed.
  const res = await fetch(`${PIPER_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'piper',
      voice: input.voice,
      input: input.text,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`piper ${res.status}: ${await res.text()}`);
  return { bytes: await res.arrayBuffer(), mimeType: 'audio/mpeg' };
}
```

Output is MP3 directly, identical content-type to the existing OpenAI path.

### XTTSv2 (via xtts-api-server)

`xtts-api-server` returns a complete WAV file. The existing `tts.ts` already
ships WAV bytes through to the client for Gemini, so we return WAV verbatim
— no MP3 transcoding needed. The cache schema stores bytes opaquely with the
`mimeType` shown in the response, matching the existing Gemini path.

```ts
async function synthesizeXtts(input: SynthesizeInput): Promise<SynthesizeOutput> {
  // input.voice is the bare language code ('en', 'it', ...) — engine
  // identity lives in input.model ('xtts'). No prefix needed.
  const langCode = input.voice ?? 'en';
  const res = await fetch(`${XTTS_BASE_URL}/tts_to_audio/`, {  // trailing slash matters
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      speaker_wav: 'Claribel Dervla',  // default built-in speaker
      language: langCode,
    }),
  });
  if (!res.ok) throw new Error(`xtts ${res.status}: ${await res.text()}`);
  return { bytes: await res.arrayBuffer(), mimeType: 'audio/wav' };
}
```

## Image — ComfyUI and Draw Things

The existing image provider directory `src/sessions/image-providers/` has
no index.ts dispatcher — providers are picked inline in
`src/sessions/scene-image-job.ts`. We extend the same `if/else` block to
add a `'local'` branch that prefix-routes by the `imageModel` field:

```ts
// In scene-image-job.ts, inside generateAndPersist:
let result: ImageGenResult;
if (provider === 'local') {
  if (model.startsWith('comfyui:')) {
    result = await generateBytesComfyUI(fullPrompt, model.slice('comfyui:'.length));
  } else if (model.startsWith('draw-things:')) {
    result = await generateBytesDrawThings(fullPrompt, model.slice('draw-things:'.length));
  } else {
    result = { ok: false, reason: 'api_error', detail: `unknown local engine in model "${model}"` };
  }
} else if (provider === 'gemini') {
  result = await generateBytesGemini(fullPrompt, model);
} else {
  result = await generateBytesOpenAI(fullPrompt, model);
}
```

The two new functions live in `src/sessions/image-providers/comfyui.ts` and
`draw-things.ts`, mirroring the existing `openai.ts` and `gemini.ts` pattern
(exporting a `generateBytes*` function that returns `ImageGenResult`).

### ComfyUI

ComfyUI is a node graph. We ship a small set of workflow JSON templates
with the app and inject the prompt as text replacement. Returns the
codebase-standard `ImageGenResult` shape:

```ts
export async function generateBytesComfyUI(prompt: string, workflowSlug: string): Promise<ImageGenResult> {
  try {
    const workflowName = workflowSlug || process.env.COMFYUI_FLUX_WORKFLOW || 'flux-schnell';
    const template = await loadWorkflowTemplate(workflowName);  // reads from disk
    const workflow = JSON.parse(template.replace('{{PROMPT}}', escapeJsonString(prompt)));

    // 1. Submit
    const submitRes = await fetch(`${process.env.COMFYUI_BASE_URL}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    });
    if (!submitRes.ok) return { ok: false, reason: 'api_error', detail: `submit ${submitRes.status}` };
    const { prompt_id } = await submitRes.json();

    // 2. Poll history
    const startTime = Date.now();
    while (Date.now() - startTime < 60_000) {
      const histRes = await fetch(`${process.env.COMFYUI_BASE_URL}/history/${prompt_id}`);
      const hist = await histRes.json();
      const entry = hist[prompt_id];
      if (entry?.status?.completed) {
        const output = entry.outputs?.['9']?.images?.[0];  // node 9 = SaveImage in our template
        if (!output) return { ok: false, reason: 'empty_response' };
        // 3. Fetch image bytes
        const viewRes = await fetch(
          `${process.env.COMFYUI_BASE_URL}/view?filename=${encodeURIComponent(output.filename)}` +
          `&subfolder=${encodeURIComponent(output.subfolder ?? '')}&type=output`
        );
        if (!viewRes.ok) return { ok: false, reason: 'api_error', detail: `view ${viewRes.status}` };
        return { ok: true, bytes: Buffer.from(await viewRes.arrayBuffer()) };
      }
      await sleep(1000);
    }
    return { ok: false, reason: 'api_error', detail: 'comfyui: 60s timeout' };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
```

The workflow template (`comfyui-workflows/flux-schnell.json`) is a literal
export from the ComfyUI UI with the positive prompt node's `text` field
replaced by `"{{PROMPT}}"`. Phase 1 ships only this one. Future workflows
(Flux Dev, SDXL Turbo) get their own JSONs and the dropdown gains entries.

### Draw Things

Draw Things exposes the AUTOMATIC1111 Stable Diffusion API:

```ts
export async function generateBytesDrawThings(prompt: string, modelName: string): Promise<ImageGenResult> {
  try {
    const res = await fetch(`${process.env.DRAW_THINGS_BASE_URL}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        negative_prompt: '',
        width: 1024,
        height: 1024,
        steps: 8,
        sampler_name: 'DPM++ 2M Karras',
        override_settings: { sd_model_checkpoint: modelName },
      }),
    });
    if (!res.ok) return { ok: false, reason: 'api_error', detail: `${res.status}` };
    const json = await res.json() as { images?: string[] };
    if (!json.images?.[0]) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(json.images[0], 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
```

## Sub-model enumeration

Five enumerators in `src/lib/local-services.ts`, all called server-side at
Settings page render and returned as `ModelOption[]` (existing shape:
`{slug, label, blurb}`).

### Ollama (LLM) — dynamic with whitelist

```ts
const LOCAL_LLM_PATTERNS: RegExp[] = [
  /^qwen3(:|$)/i,                 // qwen3, qwen3:30b-a3b
  /^gpt-oss(:|$)/i,               // gpt-oss, gpt-oss:20b
  /^hf\.co\/.+\/qwen3[^/]*/i,     // hf.co/<org>/qwen3-...
  /^hf\.co\/.+\/gpt-oss[^/]*/i,   // hf.co/unsloth/gpt-oss-20b-GGUF
];

function matchesLlmWhitelist(name: string): boolean {
  return LOCAL_LLM_PATTERNS.some((p) => p.test(name));
}

function normalizeOllamaLabel(name: string): string {
  // hf.co/unsloth/gpt-oss-20b-GGUF:F16 → unsloth/gpt-oss-20b (F16)
  if (name.startsWith('hf.co/')) {
    const stripped = name.slice('hf.co/'.length);
    const colon = stripped.lastIndexOf(':');
    const path  = colon >= 0 ? stripped.slice(0, colon) : stripped;
    const tag   = colon >= 0 ? stripped.slice(colon + 1) : '';
    const clean = path.replace(/-GGUF$/i, '');
    return tag ? `${clean} (${tag})` : clean;
  }
  return name;
}

async function fetchOllamaModels(): Promise<ModelOption[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(2000),
  });
  const { models } = await res.json();
  return models
    .filter((m) => matchesLlmWhitelist(m.name))
    .map((m) => ({
      slug: m.name,
      label: normalizeOllamaLabel(m.name),
      blurb: [m.details?.parameter_size, m.details?.quantization_level]
        .filter(Boolean).join(' · ') || 'local',
    }));
}
```

### Piper (TTS) — dynamic from `/v1/audio/voices`

```ts
async function fetchPiperVoices(): Promise<ModelOption[]> {
  const res = await fetch(`${PIPER_BASE_URL}/v1/audio/voices`, {
    signal: AbortSignal.timeout(2000),
  });
  const voices: { id: string; language?: string; quality?: string }[] = await res.json();
  return voices.map((v) => ({
    slug: `piper:${v.id}`,
    label: v.id,
    blurb: [v.language, v.quality].filter(Boolean).join(' · ') || 'piper',
  }));
}
```

### XTTSv2 (TTS) — hardcoded language list

XTTSv2 supports many built-in speakers but voice cloning is out of scope.
Phase 1 exposes one default speaker per supported language:

```ts
const XTTS_LANGUAGES = [
  { code: 'en',    label: 'English' },
  { code: 'it',    label: 'Italian' },
  { code: 'es',    label: 'Spanish' },
  { code: 'fr',    label: 'French' },
  { code: 'de',    label: 'German' },
  { code: 'pt',    label: 'Portuguese' },
  { code: 'pl',    label: 'Polish' },
  { code: 'ja',    label: 'Japanese' },
  { code: 'zh-cn', label: 'Chinese' },
] as const;

function listXttsVoices(): ModelOption[] {
  return XTTS_LANGUAGES.map((l) => ({
    slug: `xtts:${l.code}`,
    label: `${l.label} (default)`,
    blurb: 'xtts · neural',
  }));
}
```

### ComfyUI — hardcoded curated workflows

```ts
const COMFYUI_WORKFLOWS: ModelOption[] = [
  { slug: 'comfyui:flux-schnell', label: 'Flux.1 Schnell', blurb: 'fast · 4 steps' },
  { slug: 'comfyui:flux-dev',     label: 'Flux.1 Dev',     blurb: 'quality · 20 steps (phase 2)' },
  { slug: 'comfyui:sdxl-turbo',   label: 'SDXL Turbo',     blurb: 'lightweight · 1 step (phase 2)' },
];
```

Only `flux-schnell` has a JSON template shipped in phase 1; the other two
appear in the dropdown but throw at generation time with a "not implemented"
error if selected (defensive). Phase 2 adds the JSONs.

### Draw Things — dynamic from `/sdapi/v1/sd-models`

```ts
async function fetchDrawThingsModels(): Promise<ModelOption[]> {
  const res = await fetch(`${DRAW_THINGS_BASE_URL}/sdapi/v1/sd-models`, {
    signal: AbortSignal.timeout(2000),
  });
  const models: { title: string; model_name: string }[] = await res.json();
  return models.map((m) => ({
    slug: `draw-things:${m.model_name}`,
    label: m.title,
    blurb: 'draw-things · core-ml',
  }));
}
```

### Defaults on first selection

When the user switches a surface to `local` for the first time and the
preference doesn't carry a model:

| Surface | Default model |
|---|---|
| LLM | First model in the filtered Ollama list (preferring `qwen3:30b*` if present, else first `qwen3:*`, else first `gpt-oss:*`, else first hf mirror) |
| TTS | First Piper voice if Piper reachable, else `xtts:en` |
| Image | `comfyui:flux-schnell` if ComfyUI reachable, else first Draw Things checkpoint |

If no engine is reachable for a surface, `local` is hidden in that selector
(see gating rules).

## UI changes

Settings page ([src/app/(authed)/settings/settings-client.tsx](src/app/(authed)/settings/settings-client.tsx))
grows three things per surface card, each conditionally rendered:

1. **Provider radio** — a fourth "Local" button next to the existing three
   provider buttons. Rendered only when `localServices.<surface>.enabled === true`.
2. **Engine selector** — applies to TTS and Image only (LLM has only Ollama
   so doesn't need it). A small row of buttons showing each enabled engine
   for that surface. Rendered only when `provider === 'local'`.
3. **Model dropdown** — already exists. When `provider === 'local'`, the
   option list comes from the runtime enumerators (passed via prop) rather
   than from `modelsForProvider(provider)`. Engine disambiguation comes from
   the slug prefix.
4. **Status badge** — a small `✓` or `✗ unreachable` per engine displayed
   under the engine selector. Helps users diagnose "why doesn't my prompt
   work" without diving into network tools.

### Sample card — LLM with Local selected

```
┌─ Master ─────────────────────────────────────────────┐
│ Provider                                             │
│   [ Anthropic ]  [ OpenAI ]  [ Gemini ]  [ Local ✓ ] │
│                                                      │
│ Model                                                │
│   [ qwen3:30b-a3b              ▾ ]                   │
│     30b · q4_K_M                                     │
│                                                      │
│   ℹ Local environment detected · Ollama @ :11434     │
└──────────────────────────────────────────────────────┘
```

### Sample card — TTS with Local + Piper

```
┌─ Master voice (TTS) ─────────────────────────────────┐
│ Provider                                             │
│   [ OpenAI ]  [ Gemini ]  [ Local ✓ ]                │
│                                                      │
│ Engine                                               │
│   [ Piper ]  [ XTTSv2 ]                              │
│                                                      │
│ Voice                                                │
│   [ en_US-amy-low              ▾ ]                   │
│                                                      │
│   ℹ ✓ Piper @ :8050   ✗ XTTSv2 (unreachable)         │
└──────────────────────────────────────────────────────┘
```

### Engine switching behavior

When the user clicks a different engine button (e.g. Piper → XTTSv2):

1. Save resets `<surface>Voice` (or `<surface>Model`) to the new engine's
   default model (server-side via the existing PUT validator).
2. Client mirrors the reset to avoid a stale dropdown value.
3. The model dropdown re-renders with the new engine's options.

If the user switches engine while the previous voice is still valid for the
new engine (impossible by prefix design, but defensive), no reset happens.

## Preferences storage

All three provider fields are JSONB keys in `users.preferences` AND
`campaigns.settings`. Union types in both `src/db/schema/users.ts`
(`UserPreferences`) and `src/db/schema/campaigns.ts` (`CampaignSettings`)
are widened to include `'local'`. **No SQL migration** is required — both
fields are JSONB.

```ts
// users.ts — UserPreferences
type UserPreferences = {
  aiProvider?:    'anthropic' | 'openai' | 'gemini' | 'local';
  aiMasterModel?: string;  // e.g. 'qwen3:30b-a3b', 'hf.co/unsloth/gpt-oss-20b-GGUF:F16'
  ttsProvider?:   'openai' | 'gemini' | 'local';
  ttsModel?:      string;  // for 'local': 'piper' | 'xtts'
  ttsVoice?:      string;  // bare voice id depending on ttsModel
  imageProvider?: 'openai' | 'gemini' | 'local';
  imageModel?:    string;  // for 'local': 'comfyui:flux-schnell' | 'draw-things:<checkpoint>'
  // ... existing fields ...
};

// campaigns.ts — CampaignSettings (same provider fields, no ttsAutoplay)
type CampaignSettings = {
  aiProvider?:    'anthropic' | 'openai' | 'gemini' | 'local';
  aiMasterModel?: string;
  ttsProvider?:   'openai' | 'gemini' | 'local';
  ttsModel?:      string;
  ttsVoice?:      string;
  imageProvider?: 'openai' | 'gemini' | 'local';
  imageModel?:    string;
  // ... existing fields ...
};
```

For TTS, engine identity (`piper`/`xtts`) lives in **`ttsModel`** — this
follows the existing `(provider, model, voice)` triplet pattern already used
for OpenAI/Gemini. Voice slug is bare (no `engine:` prefix).

For Image, the codebase uses only `(provider, model)` — so engine identity
is encoded in the `imageModel` slug prefix: `comfyui:flux-schnell`,
`draw-things:realisticVisionV60`.

### Validation rules (PUT `/api/preferences`)

The existing per-key validation branches gain `'local'` cases:

```ts
if ('aiProvider' in body && body.aiProvider === 'local') {
  if (!isLocalEnvironment() || !process.env.OLLAMA_BASE_URL) {
    return 400 { error: 'invalid-aiProvider' };
  }
  // accept
}

if ('aiMasterModel' in body) {
  const provider = body.aiProvider ?? stored.aiProvider ?? envDefault;
  if (provider === 'local') {
    // any non-empty string ≤200 chars is accepted (Ollama slugs aren't enumerated)
  } else {
    // existing enum check
  }
}

if ('ttsVoice' in body) {
  const provider = body.ttsProvider ?? stored.ttsProvider ?? envDefault;
  if (provider === 'local') {
    // accepted iff voice starts with 'piper:' or 'xtts:' and the matching env is set
  } else {
    // existing per-provider enum check
  }
}

if ('imageModel' in body) {
  // mirror of ttsVoice: validate prefix + env
}
```

### Read-side downgrade

`getResolvedPreferences(userId)`:

```ts
const stored = await getUserPreferences(userId);
const aiProvider = (() => {
  if (stored.aiProvider !== 'local') return stored.aiProvider ?? envDefault('ai');
  if (!isLocalEnvironment() || !process.env.OLLAMA_BASE_URL) return envDefault('ai');
  return 'local';
})();
// same dance for ttsProvider, imageProvider
```

Failure of either condition silently downgrades the stored `'local'` to the
env default. The user notices on next Settings render that the radio button
moved.

## Error handling

| Failure mode | Behavior |
|---|---|
| Settings render, service unreachable | `pingService()` returns false → `EngineStatus.reachable=false` → status badge shows `✗ unreachable` inline; radio still rendered |
| Settings render, env var unset | `EngineStatus.enabled=false` → engine omitted; if all engines disabled, `local` radio is hidden for that surface |
| Stored `provider='local'` after env change | Silent downgrade in `getResolvedPreferences()` |
| Mid-turn: Ollama unreachable | `fetch` throws → propagated up through `runToolLoop` → SSE `turn_error` with `recoverable: true` (existing path) |
| Mid-turn: Piper/XTTS 5xx | `synthesizeSpeech` throws → TTS route returns 502 → existing toast |
| Mid-turn: ComfyUI 60s polling timeout | `generateAndPersist` catches, logs, leaves version untouched (existing silent-fail pattern) |
| Mid-turn: Draw Things model not loaded | Same silent-fail; logged with `upstreamStatus` |
| Tool call: model emits wrong tool / missing args | Engine handler rejects via standard tool-result error → master adapts on next round-trip |
| Wizard: model fails to emit tool_call | `proposeWizard` throws "no tool_call in response" → UI surfaces "AI failed to propose a choice"; user retries |
| Ollama `num_ctx` too small | Server returns 400 with truncation message → propagated as turn error; user must fix Modelfile (documented in setup notes) |

## Edge cases

- **Voice prefix mismatch on PUT**: e.g. `ttsVoice: 'piper:x'` while
  `ttsProvider: 'gemini'` → 400 `invalid-ttsVoice` (the prefix is invalid
  for the resolved provider). Auto-correction would mask bugs.
- **Engine reachable but no sub-models**: e.g. Piper running with zero voices
  installed → `models: []` in EngineStatus. Dropdown shows a disabled
  placeholder "No voices installed. Run: `docker exec piper piper-voices download en_US-amy-low`". Save fails with 400 until at least one voice is present.
- **ComfyUI workflow file missing on disk**: should never happen (files ship
  with the repo). Defensive: `loadWorkflowTemplate` throws "workflow template
  not found" with the resolved path included. Surfaces as a turn error.
- **HuggingFace gated models**: some models like FLUX.1-schnell require
  accepting the license on HF. If the user hasn't, the `huggingface-cli
  download` fails at setup time, not in the app. Documented in setup notes.
- **Draw Things HTTP server toggled off mid-session**: identical to
  unreachable; toast.

## Testing

Estimated count: ~310 existing + ~44 new = ~354 unit/integration tests.

### Unit tests (vitest)

```
tests/lib/local-services.test.ts                  (~10)
  • isLocalEnvironment(): NODE_ENV development → true; production → false; VERCEL=1 → false
  • matchesLlmWhitelist(): qwen3:30b-a3b ✓, gpt-oss:20b ✓, hf.co/unsloth/gpt-oss-20b-GGUF:F16 ✓,
    llama3.1:8b ✗, mistral:7b ✗
  • normalizeOllamaLabel(): qwen3:30b unchanged, hf.co/ paths rewritten, GUFF stripped
  • pingService(): ok / timeout / network error
  • fetchOllamaModels(): mocked /api/tags returning 5 models, 2 pass whitelist
  • fetchPiperVoices(): mocked response, slugs and blurbs correct
  • listXttsVoices(): all 9 languages present, slugs formatted
  • fetchDrawThingsModels(): mocked response
  • fetchLocalServicesStatus(): all 5 services up; mixed; all down

tests/ai/provider/local.test.ts                    (~6)
  • completeMessage happy path with mocked fetch
  • completeMessage 5xx throws with body included
  • detectLanguage shortcut on trivial text returns null
  • detectLanguage mocked fetch returning '"it"' returns 'it'
  • proposeWizard happy path returns toolInput
  • proposeWizard throws if response has no tool_call

tests/ai/provider/ollama-adapter.test.ts           (~12)
  • System blocks: 1, multiple, with cache_control dropped → joined into single
    role:'system' message
  • Anthropic message history → Ollama: plain user/assistant; with tool_use
    (becomes tool_calls); with multiple tool_results (fan-out)
  • Tool definition: input_schema → parameters
  • Response: text-only, tool-call-only, mixed; missing tool_calls[].id gets
    a synthetic UUID
  • done_reason mapping: 'stop' (with/without tool_calls), 'length', other
  • Usage normalization: present, missing, partial

tests/ai/tts/local.test.ts                         (~6)
  • Dispatcher routes 'piper:*' → piper.ts, 'xtts:*' → xtts.ts
  • Dispatcher throws on voice without valid prefix
  • Piper: mocked POST /v1/audio/speech returns MP3, body shape correct
  • XTTS: mocked POST /tts_to_audio/, WAV header stripped, encoded MP3
  • XTTS: 5xx throws
  • XTTS: response with malformed WAV header still parsed defensively

tests/sessions/image-providers/local.test.ts        (~10)
  • Dispatcher routes 'comfyui:*' → comfyui.ts, 'draw-things:*' → draw-things.ts
  • Dispatcher throws on model without valid prefix
  • ComfyUI: submit prompt → poll → fetch view; PNG bytes returned
  • ComfyUI: 60s polling timeout throws
  • ComfyUI: workflow JSON file missing throws clean error
  • ComfyUI: workflow template injection with prompt escaping
  • Draw Things: POST txt2img → base64 decode → PNG
  • Draw Things: 4xx throws
  • Draw Things: empty images array throws
```

### Integration tests (vitest, Next route handlers)

```
tests/api/preferences-local.test.ts                (~5)
  • PUT { aiProvider: 'local' } accepted when isLocalEnvironment + OLLAMA_BASE_URL set
  • PUT { aiProvider: 'local' } 400 when env unset
  • PUT { aiProvider: 'local' } 400 when isLocalEnvironment === false (e.g. VERCEL=1)
  • PUT { ttsVoice: 'xtts:en' } 400 when XTTS_BASE_URL unset
  • PUT { imageModel: 'comfyui:flux-schnell' } accepted; reads back identical

tests/app/api/settings-local-services.test.ts      (~3)
  • Settings page render with all services reachable → 3 'Local' options + all engines visible
  • Settings page render with only OLLAMA_BASE_URL set → 'Local' only in aiProvider
  • Settings page render with all envs set but services unreachable → 'Local' visible, badges show ✗
```

### Smoke tests (live, manual, env-gated, excluded from CI)

```
tests/ai/provider/local-live-smoke.test.ts         — needs OLLAMA_BASE_URL
  • Master turn end-to-end with qwen3:30b-a3b
  • Wizard proposal returns parseable JSON
  • Tool calling: master invokes roll_dice and receives result

tests/ai/tts/local-live-smoke.test.ts              — needs PIPER_BASE_URL || XTTS_BASE_URL
  • Real synthesis produces valid MP3 (file starts with frame sync)

tests/sessions/image-providers/local-live-smoke.test.ts — needs COMFYUI_BASE_URL || DRAW_THINGS_BASE_URL
  • Real generation produces PNG ≥ 100KB
```

### Modified existing tests

| File | Change |
|---|---|
| `tests/ai/master/tool-loop.test.ts` | Fake `MasterProvider` includes `name: 'local'` variant; no assertion changes |
| `tests/api/tts-cache.test.ts` | New case: cache rows for `(messageId, 'local', 'piper:x')` vs `(messageId, 'local', 'xtts:en')` coexist |
| `tests/lib/preferences-tts.test.ts` | Extends provider validation to `'local'` |

### Coverage targets

Tier 1 (90%) on new files: `local-services.ts`, `ollama-adapter.ts`,
`local.ts` (three new ones). Branchy logic — high coverage is straightforward
with `fetch` mocking.

## Setup notes (host services)

These are out of scope for the integration code but documented so the
implementer (and future contributors) can reproduce the dev environment.

### Ollama

```bash
ollama serve   # usually a macOS menubar app already
ollama list    # confirm at least one of: qwen3:*, gpt-oss:*, hf.co/*/qwen3*, hf.co/*/gpt-oss*
```

### Piper TTS

```bash
mkdir -p ~/local-ai/piper-config ~/local-ai/piper-voices
docker run -d --name piper \
  -p 8050:8000 \
  -v ~/local-ai/piper-config:/app/config \
  -v ~/local-ai/piper-voices:/app/voices \
  --restart unless-stopped \
  ghcr.io/matatonic/openedai-speech-min:latest
```

### XTTSv2

Native Python 3.11 venv (Docker is ~10x slower on Apple Silicon due to lack
of MPS in Linux VM):

```bash
brew install python@3.11 portaudio  # one-time
mkdir -p ~/local-ai/xtts && cd ~/local-ai/xtts
"$(brew --prefix python@3.11)/bin/python3.11" -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install xtts-api-server
pip install 'torch==2.5.1' 'torchaudio==2.5.1'  # workaround for weights_only change in torch 2.6

python -m xtts_api_server --host 0.0.0.0 --port 8055
```

The `torch==2.5.1` pin is required because PyTorch 2.6+ changed the default
`weights_only` to `True`, and Coqui's checkpoint format uses pickled Python
classes (`XttsConfig`) that the new loader rejects.
([daswer123/xtts-api-server#95](https://github.com/daswer123/xtts-api-server/issues/95))

### ComfyUI

```bash
git clone https://github.com/comfyanonymous/ComfyUI ~/local-ai/ComfyUI
cd ~/local-ai/ComfyUI
"$(brew --prefix python@3.11)/bin/python3.11" -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install -U "huggingface_hub[cli]"

huggingface-cli login  # one-time, accept FLUX.1-schnell license on HF first
huggingface-cli download black-forest-labs/FLUX.1-schnell flux1-schnell.safetensors --local-dir models/unet
huggingface-cli download comfyanonymous/flux_text_encoders clip_l.safetensors t5xxl_fp8_e4m3fn.safetensors --local-dir models/clip
huggingface-cli download black-forest-labs/FLUX.1-schnell ae.safetensors --local-dir models/vae

python main.py --listen 127.0.0.1 --port 8188
```

### Draw Things

1. Install from Mac App Store: search "Draw Things: AI Generation"
2. Open the app
3. ⌘, (Settings) → "Server" tab → enable "Enable HTTP Server"
4. Confirm port 7860
5. Models tab → download at least one (recommended: FLUX.1 [schnell] or SDXL Base 1.0)

### Shell aliases (recommended)

Add to `~/.zshrc` for fast service management — see implementation handoff
for the full block.

### `.env.local`

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_KEEP_ALIVE=5m

PIPER_BASE_URL=http://localhost:8050
XTTS_BASE_URL=http://localhost:8055

COMFYUI_BASE_URL=http://localhost:8188
COMFYUI_FLUX_WORKFLOW=flux-schnell

DRAW_THINGS_BASE_URL=http://localhost:7860
```

Not every env needs to be set — services are gated independently. The user
sets only what's running.

## Open questions / risks

- **Tool-call reliability on qwen3:30b-a3b and gpt-oss:20b**. Both are
  capable but tool-call format follow-through varies. Mitigations: defensive
  parsing in the adapter, master narrates around malformed tool calls on the
  next round-trip. Risk is acceptable; failures are surfaced, not masked.

- **Token throughput on Mac Apple Silicon**. qwen3:30b-a3b is MoE 3B active
  per token, expected ~30-50 tok/s on M2/M3 with 32GB+ unified memory. First
  turn after model load is slower (~5s warm-up). Sub-30s turn budget should
  hold once warm. Validation in smoke tests.

- **ComfyUI cold start**. First prompt loads all weights to MPS (~20-40s on
  M-series). Subsequent prompts ~10-15s. Acceptable for a "scene image"
  feature that's already async via `waitUntil`.

- **XTTSv2 `torch==2.5.1` pin brittleness**. If a transitive dependency
  later requires torch ≥2.6 for ABI reasons, this conflicts. Mitigation:
  migrate to Idiap's `coqui-ai-TTS` fork (PyTorch 2.6+ compatible) in a
  future phase.

- **Draw Things API surface stability**. Draw Things is closed-source and the
  HTTP server is documented as "AUTOMATIC1111-compatible" but undocumented
  in places. If the developer changes the endpoint shape, breakage is silent.
  Mitigation: dedicated smoke test gated by env var.

- **HuggingFace tag stability**. The whitelist patterns `hf.co/.+/qwen3*`
  could match future unrelated models named with the prefix. Acceptable —
  Ollama install is per-user and the user knows what they pulled.

- **Wizard tool forcing on local models**. Wizard demands exactly one
  tool_call. Local models occasionally emit narrative text instead. If
  reliability is poor, two follow-ups: (1) retry once with a stronger
  system prompt; (2) detect text-only response and parse JSON inline.
  Phase 1 ships with a hard fail; phase 2 may add the retry.

## Phase 2 hooks (out of scope, but designed-for)

- Add `comfyui-workflows/flux-dev.json` and `sdxl-turbo.json`. No code change
  beyond the workflow files (the slug already exists in `COMFYUI_WORKFLOWS`).
- Add XTTSv2 voice cloning: a "Voices" tab in Settings that uploads sample
  WAV files to `xtts-api-server`'s speaker library; voice slugs change from
  `xtts:<lang>` to `xtts:<lang>:<speaker-id>`.
- Add a master memory extractor (from the existing master-memory design
  doc) routed through the local provider when active.
- Remove the cloud SDKs from `package.json` once local has proven solid for
  ~3 months. Conditional imports keep the dead code out of the dev/local
  bundle in the meantime.
