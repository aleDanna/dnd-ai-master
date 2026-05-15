# Local AI Providers — Design

**Status:** Draft · **Date:** 2026-05-15 · **Author:** alessio.danna.94@gmail.com

**Supersedes:** [2026-05-05-ollama-provider-design.md](2026-05-05-ollama-provider-design.md) — incorporates and extends it.

## Goal

When the app runs in development (not on Vercel / not `NODE_ENV=production`), Settings exposes local AI provider options alongside the existing cloud ones, **per tier independently**. Master narration, TTS, and image generation each get a local option that appears only when its backing service is reachable. The user can mix freely — e.g., Claude for narration, local Kokoro for TTS, OpenAI for images.

Three local backends are blessed:

| Tier | Provider slug | Backend | Default port |
|---|---|---|---|
| Master LLM | `ollama` | Ollama (`ollama serve`) | 11434 |
| TTS | `kokoro` | Kokoro-FastAPI | 8880 |
| Image | `comfy` | ComfyUI HTTP API | 8188 |

## Non-goals

- ❌ Multi-backend per tier (e.g., Piper as a second TTS) — one blessed backend per tier
- ❌ Configuring service URL/port from the UI — fixed defaults, env var override only for edge cases
- ❌ Bundling/auto-installing Ollama, Kokoro, or ComfyUI — the user installs them separately
- ❌ Streaming responses from any local backend (`stream: false` everywhere)
- ❌ Production support: local providers are hidden when `NODE_ENV === 'production'` or `process.env.VERCEL === '1'`
- ❌ Live healthcheck polling between Settings renders or background notifications
- ❌ Auto-downgrade when a previously-saved local provider becomes unreachable — surface an explicit error instead
- ❌ Per-user backend URLs (everyone running this dev instance shares the same `OLLAMA_BASE_URL` etc.)
- ❌ Forcing local mode in production via env override (YAGNI — `isLocalModeEnabled()` stays binary)

## Architecture

### Local-mode detection

A single server-only predicate gates the entire feature:

```ts
function isLocalModeEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1';
}
```

Covered cases:
- `pnpm dev` → ✅ enabled
- Local production build (`pnpm build && pnpm start`) → ✅ enabled
- Deploy on Vercel → ❌ disabled
- Deploy on other serverless / `NODE_ENV=production` host → ❌ disabled

### Per-service probing

`probeLocalServices()` runs server-side once per Settings page render. It fires three parallel HTTP probes with a 1500 ms timeout each, then returns a typed status object the page hands to the client component as props.

```ts
interface LocalServiceStatus {
  ollama: { reachable: boolean; models: ModelOption[]; error: string | null };
  kokoro: { reachable: boolean; voices: VoiceOption[]; error: string | null };
  comfy:  { reachable: boolean; error: string | null };  // no dynamic list — hardcoded workflow
}
```

| Service | Probe endpoint | Used for |
|---|---|---|
| Ollama | `GET /api/tags` | Dynamic list of installed models |
| Kokoro | `GET /v1/audio/voices` | Dynamic list of available voices |
| ComfyUI | `GET /system_stats` | Health check only (workflow is hardcoded) |

No caching. Settings render is on-demand and infrequent; pinging on every open is acceptable. During a turn we never re-probe — if a service drops mid-turn the normal HTTP error path surfaces.

### Provider taxonomy

Each tier's provider name union widens by one:

- `ProviderName`: `'anthropic' | 'openai' | 'gemini'` → `'anthropic' | 'openai' | 'gemini' | 'ollama'`
- `TtsProvider`: `'openai' | 'gemini'` → `'openai' | 'gemini' | 'kokoro'`
- `ImageProviderName`: `'openai' | 'gemini'` → `'openai' | 'gemini' | 'comfy'`

All three are JSONB keys in `users.preferences`, not DB columns, so the change is TypeScript-only — no Drizzle migration.

## Tier 1 — Master LLM (Ollama)

Largely the same as the previous spec; the section below records the deltas.

**File map**:
- `src/ai/provider/ollama.ts` — `OllamaProvider` implementing `MasterProvider`
- `src/ai/provider/ollama-adapter.ts` — Anthropic↔Ollama conversions for tools, messages, system, response, usage

The adapter behavior — system block merging, tool definition translation, message history flattening, tool_use ↔ tool_calls, tool_result ↔ `role:'tool'` messages, synthetic tool-call ids via `crypto.randomUUID()` — is unchanged from the 2026-05-05 spec.

### Delta vs. 2026-05-05 spec

**Gate mechanism**:
- Old: `OLLAMA_BASE_URL` env var both as gate and config.
- New: `isLocalModeEnabled() && ollamaProbed.reachable` is the gate. `OLLAMA_BASE_URL` remains as an override of the default URL (`http://localhost:11434`), not as a gate.

**Thinking control** (not in old spec):

The adapter inspects the model slug to apply per-family thinking controls:

| Model family | Adapter behavior (default = OFF) |
|---|---|
| `qwen3:*` | Append `/no_think` directive to the last system block when thinking OFF; append `/think` when ON |
| `gpt-oss:*` | Add `options.reasoning_effort: 'low'` to request body when OFF; `'high'` when ON |
| Other | No injection |

Default is OFF (maximum narration speed). Override via `OLLAMA_THINKING_MODE=on`. Not surfaced in UI for v1 (YAGNI).

### Tool calling

Ollama's native `/api/chat` accepts OpenAI-shape tools (`tools: [{type:'function', function:{name, description, parameters}}]`). The adapter translates Anthropic's `input_schema` → `parameters` and back-translates tool calls to Anthropic's `tool_use` content blocks.

Stop-reason mapping:
- `done_reason: 'stop'` + non-empty `tool_calls` → `'tool_use'`
- `done_reason: 'stop'` + empty `tool_calls` → `'end_turn'`
- `done_reason: 'length'` → `'max_tokens'`
- anything else → `'other'`

Usage normalization:
- `inputTokens = json.prompt_eval_count ?? 0`
- `outputTokens = json.eval_count ?? 0`
- `cacheReadTokens = 0`, `cacheCreationTokens = 0` (no prompt-cache concept in Ollama)

## Tier 2 — TTS (Kokoro)

The existing `src/ai/tts.ts` is a flat dispatcher (`if provider === 'gemini' ... else openai`). Kokoro slots in as a third branch.

**File map**:
- `src/ai/tts.ts` — adds `synthesizeKokoro` branch
- `src/lib/tts-voices.ts` — widens `TtsProvider` union and adds Kokoro voice metadata

```ts
async function synthesizeKokoro(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const resp = await fetch(`${KOKORO_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model ?? 'kokoro',
      voice: input.voice ?? KOKORO_DEFAULT_VOICE,
      input: input.text,
      response_format: 'mp3',
    }),
  });
  if (!resp.ok) throw new Error(`kokoro tts ${resp.status}: ${await resp.text()}`);
  return { bytes: await resp.arrayBuffer(), mimeType: 'audio/mpeg' };
}
```

**Voice list**: fetched dynamically at probe time. The Settings dropdown filters to voices matching the session's narrative language when known (Italian voices have the `im_` prefix in Kokoro's naming convention; English `af_`/`am_`; etc.).

**Cache**: the existing `tts-cache` table already includes the provider in the cache key, so Kokoro audio cohabits cleanly with OpenAI/Gemini audio.

## Tier 3 — Image generation (ComfyUI)

The most involved of the three integrations. ComfyUI uses a workflow-graph paradigm and async generation via a prompt queue. There's no single "give me an image" endpoint.

**File map**:
- `src/sessions/image-providers/comfy.ts` — provider implementation
- `src/sessions/image-providers/comfy-workflows/flux-schnell.json` — hardcoded workflow template

### Flow

```
1. Load workflow template (Flux Schnell, ~30-50 nodes)
2. Inject prompt into the CLIPTextEncode node's "text" field
3. POST /prompt with { prompt: workflow } → { prompt_id }
4. Poll GET /history/{prompt_id} every 500ms (max 60s total)
5. On completion, read output filename from history
6. GET /view?filename=... → PNG bytes
7. Return { ok: true, bytes }
```

### Why hardcoded workflow

Flux Schnell topology for txt2img is stable: CheckpointLoaderSimple → CLIPTextEncode (pos + neg) → KSampler (4 steps) → VAEDecode → SaveImage. The workflow JSON is committed to the repo and patched only at the text-encode node. No UI surface for workflow editing.

If the user wants SDXL Turbo or another model, they swap the JSON file and update the model loader node name. Out of scope for v1.

### Result shape

Identical to OpenAI/Gemini image providers — same `ImageGenResult` discriminated union, same `{ ok: true; bytes }` / `{ ok: false; reason; detail? }` shape — so `scene-image-job.ts` doesn't need to special-case ComfyUI.

## Settings UI

### Server component (`src/app/(authed)/settings/page.tsx`)

```ts
const localStatus = await probeLocalServices();
return <SettingsClient
  initialPreferences={prefs}
  ttsModel={ttsModel}
  localStatus={localStatus}
/>;
```

### Client component (`src/app/(authed)/settings/settings-client.tsx`)

Each tier's provider list is conditionally extended:

```tsx
const masterProviders: ProviderName[] = [
  'anthropic', 'openai', 'gemini',
  ...(localStatus.ollama.reachable ? ['ollama' as const] : []),
];

const ttsProviders: TtsProvider[] = [
  'openai', 'gemini',
  ...(localStatus.kokoro.reachable ? ['kokoro' as const] : []),
];

const imageProviders: ImageProviderName[] = [
  'openai', 'gemini',
  ...(localStatus.comfy.reachable ? ['comfy' as const] : []),
];
```

In production, all three `reachable` flags are `false` (probes return early via `isLocalModeEnabled()`), so the UI is identical to today.

### Model/voice dropdown per local provider

- `aiProvider === 'ollama'` → dropdown sourced from `localStatus.ollama.models`. Empty list → disabled option "No models pulled. Run: `ollama pull qwen3:30b-a3b`".
- `ttsProvider === 'kokoro'` → dropdown sourced from `localStatus.kokoro.voices`, filtered by session locale.
- `imageProvider === 'comfy'` → no dropdown. Static label: "Flux.1 Schnell (ComfyUI)".

### Labels

Local providers are labeled to distinguish from cloud:
- "Ollama (locale)"
- "Kokoro (locale)"
- "ComfyUI · Flux Schnell (locale)"

### Edge case: saved provider no longer reachable

A user picks `ollama` in Settings, restarts the app without Ollama running. On the next Settings render:
1. The `ollama` radio is rendered as **selected but disabled**, with a badge "non raggiungibile, ripristina `ollama serve`".
2. The model dropdown is empty/disabled.
3. The Save button is disabled until the user switches to a reachable provider.

On the next master turn under this state, `getResolvedPreferences` does **not** auto-downgrade — instead the turn throws an explicit error ("Ollama provider selected but unreachable"). The user sees an actionable message rather than confusing silent fallback to Claude/OpenAI.

## Data flow

### Master turn (Ollama)
```
turn route → getResolvedPreferences (reads 'ollama' from DB)
  → getProviderByName('ollama') → OllamaProvider (cached singleton)
  → runToolLoop → provider.completeMessage({systemBlocks, messages, tools, model})
  → ollama-adapter: Anthropic shape → Ollama shape
       (system blocks merged into one 'system' field)
       (qwen3:* detected → '/no_think' appended to system)
       (tool_results → role:'tool' messages, one per result)
       (assistant tool_use → tool_calls)
  → POST {OLLAMA_BASE_URL}/api/chat (stream:false, keep_alive)
  → adapter: response.message → ContentBlock[]
       (synthetic ids generated for each tool_call)
  → recordUsage({prompt_eval_count, eval_count, 0, 0})
```

### TTS reply (Kokoro)
```
turn-reply stream → cache miss → synthesizeSpeech({provider:'kokoro', voice, text})
  → POST {KOKORO_BASE_URL}/v1/audio/speech (OpenAI-compatible payload)
  → return { bytes, mimeType: 'audio/mpeg' }
  → cache write keyed by (provider='kokoro', voice, hash(text))
```

### Scene image (ComfyUI)
```
scene-image-job pickup → generateBytesComfy(prompt)
  → load workflow template
  → inject prompt into CLIPTextEncode node
  → POST {COMFY_BASE_URL}/prompt → { prompt_id }
  → poll {COMFY_BASE_URL}/history/{prompt_id} every 500ms (timeout 60s)
  → done → GET {COMFY_BASE_URL}/view?filename=... → PNG bytes
  → return { ok: true, bytes }
```

## Error handling

| Scenario | Behavior |
|---|---|
| Service unreachable at Settings render | Radio hidden for that tier only |
| Service unreachable mid-turn (LLM) | Throw → `turn_error` SSE with `recoverable: true`, no state mutated |
| Service unreachable mid-turn (TTS) | 502 to client, audio playback skipped, narration text still shown |
| Service unreachable mid-turn (image) | Job marked failed, scene rendered without image (existing path) |
| Saved provider no longer reachable at render | Radio disabled + badge, Save disabled, no auto-downgrade |
| Ollama model not pulled (404 from /api/chat) | Throw with `ollama pull <model>` hint in the message |
| Kokoro voice not installed | Kokoro returns 422; throw with the voice name in the error |
| ComfyUI workflow node missing / malformed | Throw with ComfyUI's error body inline |
| ComfyUI generation timeout (>60s) | Return `{ ok: false, reason: 'api_error', detail: 'timeout' }` |
| Probe timeout (>1500ms) | Treated as unreachable for that tier; other tiers unaffected |

## File map

### New files

```
src/ai/provider/ollama.ts
src/ai/provider/ollama-adapter.ts
src/lib/local-services.ts
src/sessions/image-providers/comfy.ts
src/sessions/image-providers/comfy-workflows/flux-schnell.json

tests/ai/provider/ollama.test.ts
tests/ai/provider/ollama-adapter.test.ts
tests/lib/local-services.test.ts
tests/ai/tts-kokoro.test.ts
tests/sessions/image-providers/comfy.test.ts
```

### Modified files

```
src/ai/provider/types.ts                       — ProviderName += 'ollama'
src/ai/provider/index.ts                       — switch case 'ollama' for getProviderByName + reset
src/lib/ai-models.ts                           — extend ProviderName, ImageProviderName; helper funcs
src/lib/tts-voices.ts                          — TtsProvider += 'kokoro'; voice metadata
src/lib/preferences.ts                         — accept new provider slugs; no auto-downgrade
src/db/schema/users.ts                         — widen aiProvider/ttsProvider/imageProvider unions (TS only)
src/ai/tts.ts                                  — synthesizeKokoro branch
src/app/api/preferences/route.ts               — reject local provider slug when probe says unreachable
src/app/(authed)/settings/page.tsx             — probeLocalServices() → props
src/app/(authed)/settings/settings-client.tsx  — conditional radio rendering per tier
```

### Unchanged

- `src/ai/master/tool-loop.ts` — provider-agnostic
- `src/ai/master/language.ts`, `src/ai/wizard/loop.ts` — already dispatch via `getProviderByName(prefs.aiProvider)`
- `src/app/api/sessions/[id]/turn/route.ts` — provider-agnostic
- `src/sessions/scene-image-job.ts` — already dispatches by `imageProvider`; new branch added in its switch only
- Drizzle migrations — no schema changes (JSONB keys widen at the TS level only)

## Testing

### Unit (vitest, fully mocked)

- **`local-services.test.ts`** — probes reachable, probes timeout, probes 500, `isLocalModeEnabled()` returns false in production, returns true in development
- **`ollama.test.ts`** — `completeMessage` happy path, non-200 throws, `keep_alive` from env, thinking-mode injection per model family, `detectLanguage` short-circuit, `proposeWizard` happy path + missing-tool-call error, `recordUsage` invoked when `userId` set
- **`ollama-adapter.test.ts`** — system block merge (one, many, with `cache_control` dropped), message history conversions (plain, tool_use, tool_result fan-out), tool definition translation, response → ContentBlock[] (text-only, tool-only, mixed), done_reason mapping, synthetic tool-call id generation, usage normalization
- **`tts-kokoro.test.ts`** — happy path, 4xx error throws with body, voice fallback to default, voice list parsing
- **`comfy.test.ts`** — workflow JSON injection at correct node, polling resolves after N iterations, polling timeout produces `{ ok: false }`, error response from `/prompt` produces `{ ok: false }`, `/view` 404 produces `{ ok: false }`

### Integration

None — CI doesn't have Ollama, Kokoro, or ComfyUI. All providers exercised via mocked `fetch`.

### Manual smoke (dev only)

1. **Ollama**: `ollama serve` + `ollama pull qwen3:30b-a3b` → open Settings → Ollama radio appears, dropdown lists model → switch to Ollama, run a turn, verify narration + tool calls
2. **Kokoro**: start Kokoro-FastAPI on 8880 → open Settings → Kokoro radio appears, voices listed → switch, complete a turn, verify audio plays
3. **ComfyUI**: start ComfyUI on 8188 with Flux Schnell weights → open Settings → ComfyUI radio appears → switch, trigger a scene with imagery, verify image renders
4. **Mixed**: Claude master + Kokoro TTS + OpenAI image — confirm each tier independent
5. **Service drop**: stop Ollama, re-open Settings → radio disabled with badge; attempt a turn → explicit error in the UI

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Override Ollama URL (non-default port, WSL, LAN) |
| `OLLAMA_MASTER_MODEL` | (none — uses first installed) | Default master model when Settings hasn't picked one |
| `OLLAMA_THINKING_MODE` | `off` | `on` to enable `/think` (qwen3) + `reasoning_effort: 'high'` (gpt-oss) |
| `OLLAMA_KEEP_ALIVE` | `5m` | Keep model warm between requests |
| `KOKORO_BASE_URL` | `http://localhost:8880` | Override Kokoro URL |
| `KOKORO_DEFAULT_VOICE` | `im_nicola` | Default Italian voice |
| `COMFY_BASE_URL` | `http://localhost:8188` | Override ComfyUI URL |
| `COMFY_GEN_TIMEOUT_MS` | `60000` | Total polling budget for image generation |

## Open questions / risks

- **Tool-call reliability on local LLMs.** qwen3:30b-a3b and gpt-oss:20b both support native tool calling, but reliability under the project's many-tool prompt is unverified. We surface tool errors normally; the master loop adapts. Risk acceptable.
- **Context length.** Ollama's default `num_ctx` is 2048 — the master prompt is much larger. Relies on the user's `ollama pull` setting a sane context size via Modelfile, or future env var `OLLAMA_NUM_CTX`. Out of scope for v1.
- **Cold-start latency.** First request after model load can be 30s+. `keep_alive: '5m'` mitigates subsequent turns. Users see a slow first turn; acceptable.
- **Kokoro Italian quality.** Kokoro 1.0 supports Italian but quality is below OpenAI/Gemini for some voices. Smoke test will surface; if unacceptable we revisit (Piper, XTTS) as a separate spec.
- **ComfyUI workflow brittleness.** A ComfyUI version bump that changes node IDs would break the hardcoded workflow. Mitigation: pin the workflow to a known-good Flux Schnell node graph and document the ComfyUI version compatibility in the README when we wire it up.
- **Probe noise during HMR.** In dev with hot reload, opening Settings repeatedly fires probes. 1.5s timeout caps the cost. If observed annoying, add a 5s in-memory cache keyed by `process.pid`. Defer.
