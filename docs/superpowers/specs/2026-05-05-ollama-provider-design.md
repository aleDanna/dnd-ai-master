# Ollama Provider — Design

**Status:** Superseded by [2026-05-15-local-ai-providers-design.md](2026-05-15-local-ai-providers-design.md) · **Date:** 2026-05-05 · **Author:** alessio.danna.94@gmail.com

> **⚠️ This spec is superseded.** The 2026-05-15 design extends the scope to TTS and image generation alongside Ollama, replaces the `OLLAMA_BASE_URL`-as-gate mechanism with `NODE_ENV`-based auto-detect plus per-service probing, and adds thinking control for qwen3 / gpt-oss. The technical content below remains accurate for the Ollama-provider-only slice; refer to the new spec for the full picture.

## Goal

Add Ollama as a third AI provider alongside Anthropic and OpenAI, so users can run the master locally against an Ollama server (`ollama serve`). Ollama is selectable per-user in Settings — same mechanism as Anthropic vs. OpenAI today — but only when the deployment has set `OLLAMA_BASE_URL`. Talking to Ollama uses Ollama's own native protocol (`/api/chat`, `/api/tags`), not its OpenAI-compat shim.

## Non-goals

- ❌ Per-user Ollama URL (everyone shares `OLLAMA_BASE_URL`)
- ❌ Authentication/token forwarding to Ollama (it's assumed to be reachable from the Next.js server without auth — typical of a self-hosted local server)
- ❌ Streaming responses from Ollama (`stream: false` is fine — the existing tool-loop is round-trip-based, not streaming)
- ❌ Ollama-specific options surfaced in the UI (`num_ctx`, `temperature`, etc.) — `keep_alive` is set globally via env, nothing else
- ❌ Live `/api/tags` polling from the client — the model list is fetched server-side at settings page render only
- ❌ Production deploy of Ollama itself; this design only adds the integration. Whoever runs the app provides the server.
- ❌ Image generation or TTS via Ollama (those continue to use OpenAI as today)
- ❌ Migration helpers for users who selected Ollama and then lost access to it — they silently fall back to the env default

## Architecture

A new `OllamaProvider` class implements the existing `MasterProvider` interface (`src/ai/provider/types.ts`). It talks to Ollama directly via `fetch` against two endpoints — `/api/chat` for the three AI operations, and `/api/tags` (called only at settings page render) for the model picker. No new SDK dependency; Ollama's REST API is small enough to call directly.

The internal canonical message/tool shape stays Anthropic-flavoured (as it is today). A new `ollama-adapter.ts` converts:
- Anthropic system blocks → merged into a single `system` field on the first message
- Anthropic tool definitions → Ollama's `tools: [{type:'function', function:{name, description, parameters}}]` (same shape as OpenAI)
- Anthropic message history → Ollama's flat `messages` array, where assistant `tool_use` blocks become `tool_calls` and user `tool_result` blocks become separate `role:'tool'` messages
- Ollama response → `ContentBlock[] + stopReason + NormalizedUsage` (mapping `prompt_eval_count`→`inputTokens`, `eval_count`→`outputTokens`, cache fields → 0 since Ollama has no prompt-cache concept)

Provider availability is gated server-side: `OLLAMA_BASE_URL` must be set, or the third "Ollama" radio is hidden, the preferences API rejects `aiProvider:'ollama'`, and `getResolvedPreferences` silently downgrades a stored `'ollama'` to the env default. This avoids a confusing UX where a user picks Ollama in dev, redeploys to a host without it, and gets opaque turn errors.

## File map

**New files:**

```
src/ai/provider/
├── ollama.ts                — OllamaProvider implementing MasterProvider
└── ollama-adapter.ts        — Anthropic↔Ollama conversions for tools, messages, system, response, usage

src/lib/
└── ollama-server.ts         — Server-only helpers: isOllamaEnabled(), fetchOllamaModels()

tests/ai/provider/
├── ollama-adapter.test.ts   — adapter round-trips
└── ollama.test.ts           — provider with mocked fetch
```

**Modified files:**

- `src/ai/provider/types.ts` — extend `ProviderName` to `'anthropic' | 'openai' | 'ollama'`
- `src/ai/provider/index.ts` — add `OllamaProvider` to `getProviderByName` switch and `_resetMasterProviderForTests`
- `src/lib/ai-models.ts` — extend `ProviderName` to include `'ollama'`; `modelsForProvider('ollama')` returns `[]` (UI passes the runtime list separately); `defaultModelForProvider('ollama')` reads `OLLAMA_MASTER_MODEL` env (no static default — caller must handle empty); `isKnownProvider` accepts `'ollama'`; `isKnownMasterModel` returns `true` for any non-empty string ≤200 chars when paired with `'ollama'` (Ollama slugs aren't enumerated)
- `src/db/schema/users.ts` — extend `aiProvider` union to `'anthropic' | 'openai' | 'ollama'`
- `src/lib/preferences.ts` — `envDefaultProvider` accepts `'ollama'`; `envDefaultMasterModel('ollama')` reads `OLLAMA_MASTER_MODEL`; `getResolvedPreferences` silently downgrades stored `'ollama'` to the env default when `process.env.OLLAMA_BASE_URL` is unset
- `src/app/api/preferences/route.ts` — `aiProvider:'ollama'` is rejected with 400 unless `OLLAMA_BASE_URL` is set; `aiMasterModel` validation relaxed to accept any non-empty string ≤200 chars when the (incoming or stored) provider is `'ollama'`
- `src/app/(authed)/settings/page.tsx` — calls `isOllamaEnabled()` and (if enabled) `fetchOllamaModels()`; passes `ollamaEnabled`, `ollamaModels`, `ollamaError` to `SettingsClient`
- `src/app/(authed)/settings/settings-client.tsx` — props extended; third "Ollama" radio rendered only when `ollamaEnabled === true`; when `aiProvider === 'ollama'`, the model dropdown uses the prop list (`ollamaModels`) instead of `modelsForProvider`; when the list is empty, the dropdown shows a single disabled option with the error message ("Ollama unreachable — start `ollama serve`")

**No changes needed:**
- `src/ai/master/tool-loop.ts` — provider-agnostic, works as-is
- `src/ai/master/language.ts`, `src/ai/wizard/loop.ts` — already dispatch via `getProviderByName(prefs.aiProvider)`
- `src/app/api/sessions/[id]/turn/route.ts` — already provider-agnostic
- `src/ai/tts.ts` — explicitly OpenAI-only (TTS isn't an Ollama feature)
- Drizzle migrations — `aiProvider` is a JSONB key, not a column, so the union widening is purely a TS-type change

## Provider implementation

`OllamaProvider` mirrors `OpenAIProvider`'s structure for parity. Pseudocode:

```ts
const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MASTER_MODEL = process.env.OLLAMA_MASTER_MODEL ?? 'llama3.1:8b';
const LANGUAGE_MODEL = process.env.OLLAMA_LANGUAGE_MODEL ?? MASTER_MODEL;
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '5m';

class OllamaProvider implements MasterProvider {
  readonly name = 'ollama' as const;

  async completeMessage(input) {
    const body = {
      model: input.model ?? MASTER_MODEL,
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
      stopReason: ollamaDoneReasonToStopReason(json.done_reason),
      usage: normalizeOllamaUsage(json),
    };
  }

  async detectLanguage(input) { /* same shape, language model, recordUsage */ }
  async proposeWizard(input) { /* same shape, single tool, recordUsage; throws if no tool_call */ }
}
```

Tool ID handling: Ollama's `tool_calls[].function` has no `id` field — the OpenAI-compat layer would synthesize one, but on the native API we generate our own. Each tool call gets `crypto.randomUUID()` at adapter time so the round-trip back through the tool-loop's `tool_use_id` matching still works. The id is only meaningful within a single turn; Ollama doesn't validate it on the way back.

Stop reason mapping:
- `done_reason: 'stop'` → `'end_turn'` (unless `tool_calls` is non-empty, then `'tool_use'`)
- `done_reason: 'length'` → `'max_tokens'`
- anything else → `'other'`

Usage:
- `inputTokens = json.prompt_eval_count ?? 0`
- `outputTokens = json.eval_count ?? 0`
- `cacheReadTokens = 0`, `cacheCreationTokens = 0` (Ollama has no prompt cache concept)

## Server-side helper

`src/lib/ollama-server.ts`:

```ts
'server-only';
import type { ModelOption } from './ai-models';

export function isOllamaEnabled(): boolean {
  return !!process.env.OLLAMA_BASE_URL;
}

export async function fetchOllamaModels(): Promise<{
  models: ModelOption[];
  error: string | null;
}> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return { models: [], error: 'OLLAMA_BASE_URL not set' };
  try {
    const resp = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!resp.ok) return { models: [], error: `ollama ${resp.status}` };
    const json = await resp.json() as { models: { name: string; details?: { parameter_size?: string; family?: string } }[] };
    const models: ModelOption[] = json.models.map((m) => ({
      slug: m.name,
      label: m.name,
      blurb: [m.details?.family, m.details?.parameter_size].filter(Boolean).join(' · ') || 'local',
    }));
    return { models, error: null };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : 'unreachable' };
  }
}
```

`AbortSignal.timeout(2000)` keeps a stalled Ollama from blocking the settings page render.

## UI changes

In `SettingsClient`:

```tsx
interface SettingsClientProps {
  initialPreferences: Required<UserPreferences>;
  ttsModel: string;
  ollamaEnabled: boolean;        // NEW
  ollamaModels: ModelOption[];   // NEW (empty when disabled or unreachable)
  ollamaError: string | null;    // NEW (populated when fetch failed)
}

const providers: ProviderName[] = ollamaEnabled
  ? ['anthropic', 'openai', 'ollama']
  : ['anthropic', 'openai'];

// In the model dropdown:
const availableModels =
  prefs.aiProvider === 'ollama' ? ollamaModels : modelsForProvider(prefs.aiProvider);

// When availableModels is empty AND provider is 'ollama':
//   render a disabled option with `ollamaError ?? 'No models pulled. Run: ollama pull llama3.1:8b'`
```

`onProviderChange` switching to `'ollama'` picks the first model from `ollamaModels` (or `''` if the list is empty — `save()` will then fail with a 400, which surfaces in the existing error banner).

## Data flow — master turn with Ollama

```
turn route → getResolvedPreferences (downgrades 'ollama' if env unset)
  → getProviderByName('ollama') → OllamaProvider (cached singleton)
  → runToolLoop → provider.completeMessage({systemBlocks, messages, tools, model})
  → ollama-adapter: Anthropic-shape → Ollama-shape
       (system blocks → joined into a 'system' message at index 0)
       (tool_results → role:'tool' messages, one per result)
       (assistant tool_use → tool_calls on the assistant message)
  → POST {OLLAMA_BASE_URL}/api/chat (stream:false, keep_alive)
  → ollama-adapter: response.message → ContentBlock[]
       (synthetic ids generated for each tool_call so the loop can match tool_results)
  → recordUsage({inputTokens, outputTokens, 0, 0})
```

## Error handling

- `OLLAMA_BASE_URL` unset at request time but provider stored as `'ollama'` → `getResolvedPreferences` silently downgrades to env default. The next master turn uses Anthropic/OpenAI; the user sees a settings page with "Ollama" no longer selected.
- Ollama unreachable mid-turn (network error, server down) → `fetch` throws; `runToolLoop` catches via the existing turn-error handling in the route. SSE emits `turn_error` with `recoverable:true`. No partial state persisted.
- Model not pulled → Ollama returns 404 with `{"error":"model 'xxx' not found"}`. `OllamaProvider` throws an `Error` with the body included. Same SSE path.
- Model produced malformed tool args → Ollama returns `tool_calls[].function.arguments` as an already-parsed object, so JSON-level malformedness is invisible to us; if the model emits wrong/missing fields, the engine handler will reject them with a normal tool-result error and the master narrates around it next round-trip. Defensive guard: if `arguments` is unexpectedly a string (compat-layer behaviour, future API change), the adapter tries `JSON.parse` and falls back to `{ _raw: <string> }`.
- Settings page render with Ollama unreachable → `fetchOllamaModels` returns `{models:[], error}`; settings still renders, dropdown shows the error message.
- User attempts to PUT `aiProvider:'ollama'` with `OLLAMA_BASE_URL` unset → 400 `{error:'invalid-aiProvider'}` (same code path as an unknown provider).
- User attempts to PUT a model with the provider already stored as `'ollama'` but env now unset → preferences.ts downgrades the stored provider before the validation check; the model is then validated against the new provider's enum, possibly rejected. Acceptable; the user is in a broken state anyway.

## Testing

**Unit (vitest):**

- `tests/ai/provider/ollama-adapter.test.ts`:
  - System blocks: 1 block, multiple blocks, with `cache_control` (dropped) → all merged into one system message
  - Anthropic message history → Ollama: plain user, plain assistant, assistant with `tool_use`, user with one `tool_result`, user with multiple `tool_results` (fan-out)
  - Tool definition: `input_schema` → `parameters`
  - Response: text-only, tool-call-only, mixed; `done_reason` mapping; missing `tool_calls[].id` gets a synthetic one
  - Usage: present, missing, partial

- `tests/ai/provider/ollama.test.ts`:
  - `completeMessage` happy path with mocked `fetch` returning a fixture
  - `completeMessage` non-200 throws
  - `completeMessage` includes `keep_alive` from env
  - `detectLanguage` with trivial-text short-circuit returns `null`
  - `detectLanguage` with mocked fetch returning a 2-letter response
  - `proposeWizard` returns `toolInput` from a mocked tool_call
  - `proposeWizard` throws if no tool_call in response
  - `recordUsage` invoked with correct args when `userId` set

**Integration:** none — CI doesn't have Ollama. The provider is fully exercised via mocked fetch.

**Smoke test (manual, dev only):**
- `OLLAMA_BASE_URL=http://localhost:11434 pnpm dev`, pull `llama3.1:8b`, switch to Ollama in Settings, run a session turn, confirm tool calls fire.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `OLLAMA_BASE_URL` | (unset) | Server URL. When unset, Ollama is hidden from the UI and rejected by the preferences API. |
| `OLLAMA_MASTER_MODEL` | `llama3.1:8b` | Slug for the master tool-loop. Used as default when settings hasn't picked anything. |
| `OLLAMA_LANGUAGE_MODEL` | (= `OLLAMA_MASTER_MODEL`) | Slug for language detection. |
| `OLLAMA_KEEP_ALIVE` | `5m` | `keep_alive` passed on every request to keep the model warm. |

## Open questions / risks

- **Tool-call reliability on small models.** llama3.1:8b is borderline — it follows tool-call format most of the time but occasionally emits the wrong tool, missing required args, or tries to narrate inside a tool block. The engine handlers will reject malformed input as a normal tool-result error and the master loop will adapt on the next round-trip. Risk is acceptable; we surface the failure rather than masking it.
- **Context length.** Ollama's default `num_ctx` is 2048. The master prompt is much larger than that. We rely on the model file (`Modelfile`) or the user's `ollama pull` to set a sane default. If this becomes a problem we add `options.num_ctx` later — out of scope here.
- **Latency on cold start.** First request after pulling a model can take 30s+ to load weights. `keep_alive: "5m"` keeps subsequent requests warm. Users will see a slow first turn; acceptable.
