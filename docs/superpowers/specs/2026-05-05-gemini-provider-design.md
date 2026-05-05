# Gemini Provider — Design

**Status:** Draft · **Date:** 2026-05-05 · **Author:** alessio.danna.94@gmail.com

## Goal

Add Gemini as a third AI provider for the master narration (alongside Anthropic and OpenAI), and introduce a separate per-user `imageProvider` preference (OpenAI default / Gemini) with an `imageModel` selector when the user picks Gemini for images. Both selections are made in Settings; Gemini SDK access goes through `@google/genai`.

## Non-goals

- ❌ Server-side gating when `GEMINI_API_KEY` is unset (the Gemini option is always visible; first call fails with `GEMINI_API_KEY is not set`, same as OpenAI/Anthropic today)
- ❌ Per-session provider override
- ❌ Streaming responses from Gemini (`stream:false` is fine — the tool-loop is round-trip-based)
- ❌ Migration to Vercel AI Gateway / AI SDK
- ❌ TTS via Gemini (TTS stays OpenAI-only)
- ❌ Tool schema tightening (`additionalProperties:false`, `required` audit) — out of scope, same as multi-provider spec
- ❌ Gemini context caching API (orthogonal feature; `cache_control` from Anthropic blocks is dropped on the way to Gemini)
- ❌ Per-session/per-user Gemini API key (one shared `GEMINI_API_KEY`)

## Architecture

A new `GeminiProvider` class implements the existing `MasterProvider` interface (`src/ai/provider/types.ts`). It uses the `@google/genai` SDK for both the master tool-loop and image generation — single dependency for both features.

The internal canonical message/tool shape stays Anthropic-flavoured. A new `gemini-adapter.ts` converts:
- Anthropic system blocks → merged into a `systemInstruction` argument
- Anthropic tool definitions → Gemini's `tools: [{ functionDeclarations: [{name, description, parameters}] }]`
- Anthropic message history → Gemini `Content[]`, where assistant `tool_use` blocks become `functionCall` parts and user `tool_result` blocks become `functionResponse` parts
- Gemini response → `ContentBlock[] + stopReason + NormalizedUsage`

Image generation, currently hard-coded to OpenAI `gpt-image-1` in `src/sessions/scene-image-job.ts`, is refactored: `generateAndPersist` accepts `provider: 'openai' | 'gemini'` and `model: string` and dispatches to a per-provider implementation. OpenAI path is unchanged in behavior.

User preferences gain two new keys: `imageProvider` and `imageModel`. They are fully orthogonal to `aiProvider`/`aiMasterModel` — a user can pick Anthropic for the master and Gemini for images, or vice versa.

## File map

**New files:**

```
src/ai/provider/
├── gemini.ts                       — GeminiProvider implementing MasterProvider
└── gemini-adapter.ts               — Anthropic↔Gemini conversions

src/sessions/
└── image-providers/
    ├── openai.ts                   — extracted from current scene-image-job.ts
    └── gemini.ts                   — new, uses @google/genai

tests/ai/provider/
├── gemini-adapter.test.ts          — adapter round-trips
└── gemini.test.ts                  — provider with mocked SDK

tests/sessions/
└── image-providers-gemini.test.ts  — Gemini image dispatch (mocked SDK)
```

**Modified files:**

- `src/ai/provider/types.ts` — extend `ProviderName` to `'anthropic' | 'openai' | 'gemini'`
- `src/ai/provider/index.ts` — add `GeminiProvider` to `getProviderByName` switch and `_resetMasterProviderForTests`
- `src/lib/ai-models.ts` — add `GEMINI_MASTER_MODELS`, `GEMINI_IMAGE_MODELS`, `OPENAI_IMAGE_MODELS`; `modelsForProvider` extended; new `imageModelsForProvider`, `defaultImageModelForProvider`, `isKnownImageProvider`, `isKnownImageModel`; `isKnownProvider` accepts `'gemini'`; `isKnownMasterModel` covers Gemini slugs
- `src/db/schema/users.ts` — extend `aiProvider` union to include `'gemini'`; new optional `imageProvider?: 'openai' | 'gemini'` and `imageModel?: string`
- `src/lib/preferences.ts` — `envDefaultProvider` accepts `'gemini'`; `envDefaultMasterModel('gemini')` reads `GEMINI_MASTER_MODEL`; new `envDefaultImageProvider`/`envDefaultImageModel`; `DEFAULT_PREFERENCES` and `getResolvedPreferences` include `imageProvider`/`imageModel`
- `src/app/api/preferences/route.ts` — validation for `imageProvider` (`isKnownImageProvider`) and `imageModel` (`isKnownImageModel`)
- `src/sessions/scene-image-job.ts` — `generateAndPersist` accepts `provider` + `model`; dispatches to `image-providers/openai.ts` or `image-providers/gemini.ts`; persistence (race-safe UPDATE) stays in the dispatcher
- `src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts` — passes `imageProvider` + `imageModel` from resolved prefs to `generateAndPersist`
- `src/app/(authed)/settings/settings-client.tsx` — third "Gemini" button in master provider radio; new "Image provider" subsection inside the existing "Scene illustrations" card (visible only when image generation is ON), with two radios (OpenAI default / Gemini) and a model dropdown when Gemini is selected
- `package.json` — add `@google/genai`

**No changes needed:**
- `src/ai/master/tool-loop.ts` — provider-agnostic, works as-is
- `src/ai/master/language.ts`, `src/ai/wizard/loop.ts` — already dispatch via `getProviderByName(prefs.aiProvider)`
- `src/app/api/sessions/[id]/turn/route.ts` — already provider-agnostic
- `src/ai/tts.ts` — explicitly OpenAI-only (not in scope)
- Drizzle migrations — `aiProvider`/`imageProvider`/`imageModel` are JSONB keys, not columns; union widening is a TS-type change only

## Provider implementation

`GeminiProvider` mirrors `OpenAIProvider`'s structure. Pseudocode:

```ts
import { GoogleGenAI } from '@google/genai';

const MASTER_MODEL = process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
const LANGUAGE_MODEL = process.env.GEMINI_LANGUAGE_MODEL ?? 'gemini-2.5-flash-lite';

let _client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

class GeminiProvider implements MasterProvider {
  readonly name = 'gemini' as const;

  async completeMessage(input) {
    const client = getClient();
    const { systemInstruction, contents } = anthropicMessagesToGemini(
      input.systemBlocks, input.messages,
    );
    const response = await client.models.generateContent({
      model: input.model ?? MASTER_MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: input.tools.map(anthropicToolToGemini) }],
        maxOutputTokens: input.maxTokens ?? 4096,
      },
    });
    return {
      contentBlocks: geminiResponseToContentBlocks(response),
      stopReason: geminiFinishReasonToStopReason(response),
      usage: normalizeGeminiUsage(response.usageMetadata),
    };
  }

  async detectLanguage(input) { /* short-circuit, language model, recordUsage */ }
  async proposeWizard(input) { /* single tool, allowedFunctionNames forces tool_call */ }
}
```

**Tool ID synthesis.** Gemini's `functionCall` part has no `id` field. The adapter generates `crypto.randomUUID()` per tool call so the round-trip back through the tool-loop's `tool_use_id` matching still works. The id is meaningful only intra-turn — Gemini doesn't echo it back, so the adapter populates `functionResponse.name` (matched by name when sending tool results back).

**Stop reason mapping:**
- `STOP` with no functionCall → `'end_turn'`
- `STOP` with at least one functionCall → `'tool_use'`
- `MAX_TOKENS` → `'max_tokens'`
- `SAFETY` / `RECITATION` / others → `'other'`

**Usage:**
- `inputTokens = usageMetadata.promptTokenCount ?? 0`
- `outputTokens = usageMetadata.candidatesTokenCount ?? 0`
- `cacheReadTokens = usageMetadata.cachedContentTokenCount ?? 0`
- `cacheCreationTokens = 0` (Gemini context caching is a separate API not used here)

**Wizard.** `proposeWizard` uses the same `generateContent` call with a single tool definition and `toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolDefinition.name] } }` to force a function call. If the response has no matching `functionCall`, throw `AI did not call <toolName>` (parity with other providers).

## Adapter conversions (`gemini-adapter.ts`)

### Tool definitions: Anthropic → Gemini

```
{ name, description, input_schema }
```
becomes
```
{ name, description, parameters: input_schema }
```

JSON Schema is portable. Gemini accepts the same shape OpenAI does (and Anthropic does internally), so no field-by-field rewrite. `additionalProperties` is dropped if present (Gemini rejects it on some schemas) — defensive cleanup pass.

### System prompt: Anthropic → Gemini

Anthropic's system blocks `[{type:'text', text, cache_control}, ...]` are flattened by concatenating `text` values with `\n\n` and passed as `config.systemInstruction = { parts: [{ text: combined }] }`. The `cache_control` field is dropped — Gemini's context caching is opt-in via a separate API surface and out of scope.

### Messages: Anthropic → Gemini `Content[]`

| Anthropic shape | Gemini shape |
|---|---|
| `{role:'user', content:'string'}` | `{role:'user', parts:[{text:'string'}]}` |
| `{role:'assistant', content:[{type:'text',text}]}` | `{role:'model', parts:[{text}]}` |
| `{role:'assistant', content:[text + tool_use blocks]}` | `{role:'model', parts:[{text}, {functionCall:{name, args:input}} × N]}` |
| `{role:'user', content:[tool_result × N]}` | `{role:'user', parts:[{functionResponse:{name, response:{...}}} × N]}` (single user turn, multiple parts) |

The adapter looks up the tool name from the *previous* assistant message's `tool_use` blocks (matching by `tool_use_id`) to populate `functionResponse.name`, since Gemini matches results to calls by name, not id.

### Response: Gemini → internal (Anthropic-shape)

```
candidates[0].content.parts:
  {text}                                  →  {type:'text', text}
  {functionCall:{name, args}}             →  {type:'tool_use', id: crypto.randomUUID(), name, input: args}

candidates[0].finishReason:
  'STOP' (no functionCall)                →  'end_turn'
  'STOP' (with functionCall)              →  'tool_use'
  'MAX_TOKENS'                            →  'max_tokens'
  anything else (SAFETY, RECITATION, …)   →  'other'
```

Gemini's `args` is already a parsed object — no `JSON.parse` needed. Defensive guard: if `args` arrives as a string (compat-layer behavior, future API change), the adapter tries `JSON.parse` and falls back to `{ _raw: <string> }`.

### Usage normalization

| Field | Anthropic source | OpenAI source | Gemini source |
|---|---|---|---|
| `inputTokens` | `usage.input_tokens` | `usage.prompt_tokens` | `usageMetadata.promptTokenCount` |
| `outputTokens` | `usage.output_tokens` | `usage.completion_tokens` | `usageMetadata.candidatesTokenCount` |
| `cacheReadTokens` | `usage.cache_read_input_tokens` | `prompt_tokens_details?.cached_tokens` | `usageMetadata.cachedContentTokenCount ?? 0` |
| `cacheCreationTokens` | `usage.cache_creation_input_tokens` | `0` | `0` |

`recordUsage` accepts the normalized shape — no changes downstream.

## Image generation

### Refactor of `scene-image-job.ts`

Current:
```ts
generateAndPersist(sessionId, visualPrompt, styleText, expectedVersion)
```
New:
```ts
generateAndPersist(sessionId, visualPrompt, styleText, expectedVersion, provider, model)
```

The function:
1. Builds the full prompt via `buildImagePrompt(visualPrompt, styleText)` (unchanged)
2. Dispatches to `generateBytesOpenAI(prompt, model)` or `generateBytesGemini(prompt, model)` (both return `Promise<{ ok:true; bytes:Buffer } | { ok:false; reason:'empty_response'|'api_error'; detail?:string }>`)
3. On `ok:true`, runs the existing race-safe conditional UPDATE on `session_state`
4. On `ok:false`, returns the structured error to the caller (same shape as today)

### `image-providers/openai.ts`

Lifted from current `scene-image-job.ts`:
```ts
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';

export async function generateBytesOpenAI(prompt: string, model?: string) {
  const m = model ?? DEFAULT_MODEL;
  const res = await client().images.generate({ model: m, prompt, size: '1024x1024' });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) return { ok:false, reason:'empty_response' as const };
  return { ok:true, bytes: Buffer.from(b64, 'base64') };
}
```
Test seam (`__setOpenAIClientForTest`) preserved.

### `image-providers/gemini.ts`

```ts
import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';

let _client: GoogleGenAI | null = null;
let _override: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}
export function __setGeminiClientForTest(mock: GoogleGenAI | null): void { _override = mock; }

export async function generateBytesGemini(prompt: string, model?: string) {
  const m = model ?? DEFAULT_MODEL;
  try {
    if (m.startsWith('imagen-')) {
      // Imagen path
      const res = await client().models.generateImages({
        model: m,
        prompt,
        config: { numberOfImages: 1, aspectRatio: '1:1' },
      });
      const b64 = res.generatedImages?.[0]?.image?.imageBytes;
      if (!b64) return { ok:false, reason:'empty_response' as const };
      return { ok:true, bytes: Buffer.from(b64, 'base64') };
    }
    // gemini-*-image path: generateContent with image-out
    const res = await client().models.generateContent({
      model: m,
      contents: [{ role:'user', parts:[{ text: prompt }] }],
    });
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) return { ok:false, reason:'empty_response' as const };
    return { ok:true, bytes: Buffer.from(inline.data, 'base64') };
  } catch (e) {
    return { ok:false, reason:'api_error' as const, detail: e instanceof Error ? e.message : String(e) };
  }
}
```

### Manual scene-image route

`src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts`:

```ts
const prefs = await getResolvedPreferences(userId);  // was getUserPreferences
if (!prefs.imageGenerationEnabled) return NextResponse.json({ error: 'image-generation-disabled' }, { status: 403 });
const styleText = resolveStyleText(prefs);
const result = await generateAndPersist(
  sessionId, row.messageContent, styleText, nextVersion,
  prefs.imageProvider, prefs.imageModel,
);
```

The switch from `getUserPreferences` to `getResolvedPreferences` is intentional — the route needs the resolved env defaults for `imageProvider`/`imageModel`, not just the explicitly stored values.

## Models exposed

### Master (`aiMasterModel` when `aiProvider === 'gemini'`)

| slug | label | blurb | recommended |
|---|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | Most capable; deep reasoning. | ✓ |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Balanced speed and quality. | |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | Fastest, cheapest, smaller context. | |

### Image (`imageModel` when `imageProvider === 'gemini'`)

| slug | label | blurb | recommended |
|---|---|---|---|
| `gemini-2.5-flash-image` | Gemini 2.5 Flash Image | Fast and cheap; good defaults. | ✓ |
| `imagen-4.0-generate-001` | Imagen 4 | Higher quality; slower and pricier. | |

### Image (`imageModel` when `imageProvider === 'openai'`)

| slug | label | blurb | recommended |
|---|---|---|---|
| `gpt-image-1` | GPT Image 1 | Current default; high quality. | ✓ |

`OPENAI_IMAGE_MODELS` is added even though it has a single entry today, for symmetry and so future additions don't need a UI refactor.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `GEMINI_API_KEY` | — | Required when `aiProvider`=`gemini` or `imageProvider`=`gemini`; lazy fail at first call |
| `GEMINI_MASTER_MODEL` | `gemini-2.5-pro` | Default master/wizard slug |
| `GEMINI_LANGUAGE_MODEL` | `gemini-2.5-flash-lite` | Default language detection slug |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Default image slug |
| `IMAGE_PROVIDER` | `openai` | Default `imageProvider` when user hasn't picked |
| `MASTER_PROVIDER` | `anthropic` | Now also accepts `gemini` |

## Behavior matrix

| `aiProvider` (resolved) | `imageProvider` (resolved) | `*_API_KEY` | Outcome |
|---|---|---|---|
| `anthropic` | `openai` | both set | Default; current behavior |
| `gemini` | `openai` | `GEMINI_API_KEY` set, `OPENAI_API_KEY` set | Master via Gemini, images via OpenAI |
| `gemini` | `gemini` | `GEMINI_API_KEY` set | Master + images via Gemini |
| `openai` | `gemini` | both set | Master via OpenAI, images via Gemini |
| `gemini` | (any) | `GEMINI_API_KEY` unset | First master turn throws `GEMINI_API_KEY is not set` |
| (any) | `gemini` | `GEMINI_API_KEY` unset | First image generation throws `GEMINI_API_KEY is not set` |

Validation is lazy at first request, matching the existing pattern. No boot-time check.

## UI changes

### Master provider radio (existing card "Provider & model")

```tsx
{(['anthropic', 'openai', 'gemini'] as ProviderName[]).map((p) => (
  <button ...>
    {p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : 'Gemini'}
  </button>
))}
```

`onProviderChange('gemini')` picks the recommended Gemini master model (`gemini-2.5-pro`).

### "Image provider" subsection (new, inside existing "Scene illustrations" card)

Visible only when `imageGenerationEnabled === true`, rendered above the existing "Image style" dropdown:

```tsx
<label>Image provider</label>
<div>
  {(['openai','gemini'] as ImageProviderName[]).map((p) => (
    <button onClick={() => onImageProviderChange(p)} aria-pressed={prefs.imageProvider === p}>
      {p === 'openai' ? 'OpenAI' : 'Gemini'}
    </button>
  ))}
</div>

<label>Image model</label>
<select value={prefs.imageModel} onChange={onImageModelChange}>
  {imageModelsForProvider(prefs.imageProvider).map((m) => (
    <option key={m.slug} value={m.slug}>
      {m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}
    </option>
  ))}
</select>
```

`onImageProviderChange` switches the provider and resets the model to the recommended one for that provider, in a single PUT (mirrors `onProviderChange`).

## Data flow — master turn with Gemini

```
turn route → getResolvedPreferences
  → getProviderByName('gemini') → GeminiProvider (cached singleton)
  → runToolLoop → provider.completeMessage({systemBlocks, messages, tools, model})
  → gemini-adapter: Anthropic-shape → Gemini-shape
       (system blocks → systemInstruction)
       (tool_results → functionResponse parts on a single user turn)
       (assistant tool_use → functionCall parts on the model turn)
  → @google/genai client.models.generateContent
  → gemini-adapter: candidates[0].content.parts → ContentBlock[]
       (synthetic ids generated for each functionCall so the loop matches tool_results)
  → recordUsage({inputTokens, outputTokens, cacheReadTokens, 0})
```

## Error handling

- `GEMINI_API_KEY` unset, user has `aiProvider:'gemini'` → first turn throws; SSE emits `turn_error` with `recoverable:true` (existing turn-error path)
- `GEMINI_API_KEY` unset, user has `imageProvider:'gemini'` → manual scene-image POST returns 502 with `reason:'api_error'`, `detail:'GEMINI_API_KEY is not set'` (existing error envelope)
- Gemini 4xx/5xx from the SDK → caught by the same try/catch as OpenAI; for the master, the SDK error bubbles up to the turn route's existing handler; for images, returns `{ok:false, reason:'api_error', detail}`
- Model produced malformed function args → `args` arrives as an object (or string fallback). If keys are wrong/missing, the engine handler rejects with a normal tool-result error and the master narrates around it next round-trip
- `SAFETY`/`RECITATION` finishReason → `stopReason: 'other'`, contentBlocks may be empty. Tool-loop already handles empty turns gracefully (treats as end of stream)

## Testing

**Unit (vitest):**

`tests/ai/provider/gemini-adapter.test.ts` (~10 cases):
- System blocks: 1 block, multiple blocks, with `cache_control` (dropped) → merged systemInstruction
- Anthropic message history → Gemini contents: plain user, plain assistant, assistant with `tool_use`, user with one `tool_result`, user with multiple `tool_results` (single user turn, multiple functionResponse parts)
- Tool definition: `input_schema` → `parameters`, `additionalProperties` stripped
- Response: text-only, functionCall-only, mixed; finishReason mapping (4 values); synthetic id generated per functionCall
- Usage: present, missing, partial, with `cachedContentTokenCount`

`tests/ai/provider/gemini.test.ts` (~6 cases):
- `completeMessage` happy path with mocked SDK
- `completeMessage` SDK throws → bubbles up
- `detectLanguage` trivial-text short-circuit returns `null`
- `detectLanguage` mocked SDK returns 2-letter response
- `proposeWizard` returns `toolInput` from a mocked functionCall
- `proposeWizard` throws if no functionCall in response
- `recordUsage` invoked with correct args when `userId` set

`tests/sessions/image-providers-gemini.test.ts` (~4 cases):
- `generateBytesGemini` happy path with `gemini-2.5-flash-image` (generateContent inlineData)
- `generateBytesGemini` happy path with `imagen-4.0-generate-001` (generateImages)
- `generateBytesGemini` empty response → `reason:'empty_response'`
- `generateBytesGemini` SDK throws → `reason:'api_error'` with detail

**Integration:** none — CI doesn't have a Gemini key. Provider is fully exercised via mocked SDK.

**Live smoke (manual, gated by `GEMINI_API_KEY`):**
- `tests/ai/provider/gemini-live-smoke.test.ts` (2 tests) — round-trip tool call + image generation against the real API, gated like `tests/ai/master/live-smoke.test.ts`

**Existing tests — zero changes to assertions** beyond:
- `tests/ai/provider/dispatcher.test.ts` — add a case for `'gemini'`
- `tests/sessions/scene-image-job.test.ts` (if exists) — update signature to pass `provider`+`model`

**Total expected:** current ~272 + new ~22 = ~294.

## Open questions / risks

- **Gemini tool-call quality on Flash-Lite.** `gemini-2.5-flash-lite` may struggle with the 18-tool engine surface. We expose it because users may pick it for language detection (cheap), but the recommended master is `gemini-2.5-pro`. If users report bad turns on Flash-Lite, we narrow the allowed list.
- **Image model availability.** `gemini-2.5-flash-image` and `imagen-4.0-generate-001` may have regional restrictions or require billing tier. The 4xx surfaces as a normal `reason:'api_error'` with the SDK message — actionable for the user.
- **`@google/genai` SDK churn.** This SDK is newer and faster-moving than `@anthropic-ai/sdk`/`openai`. Pin to a specific minor in `package.json` and call out major upgrades explicitly.
- **`cache_control` drop.** Anthropic-side cache breakpoints are silently ignored on Gemini. The master prompt is large; without context caching, Gemini turns will be more expensive than equivalent Anthropic turns. Acceptable for MVP — context caching is a follow-up.
- **Image cost asymmetry.** Imagen 4 is significantly more expensive than `gpt-image-1`. The blurb on the option flags this; no hard guard rails (parity with the rest of the app — model choice is the user's).
