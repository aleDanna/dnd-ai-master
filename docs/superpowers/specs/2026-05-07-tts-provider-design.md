# TTS provider selection — Design

**Status:** Draft · **Date:** 2026-05-07 · **Author:** brainstormed with Claude
**Touches:** `src/ai/tts.ts` (refactor), `src/lib/tts-voices.ts` (refactor), `src/db/schema/tts-cache.ts`, `src/db/schema/users.ts`, `src/lib/preferences.ts`, `src/app/api/preferences/route.ts`, `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts`, `src/app/(authed)/settings/settings-client.tsx`, new `src/ai/tts/` module folder, new drizzle migration.

## Problem

The "Listen" button in the chat is hard-coded to OpenAI TTS (`src/ai/tts.ts` line 6: *"Always uses OpenAI regardless of MASTER_PROVIDER — Anthropic does not expose a native TTS endpoint"*). Settings expose a voice picker (10 OpenAI voices) but no provider toggle. Users that prefer Gemini's voices, or that want to pay through their Google billing only, have no way to select that provider.

The existing `aiProvider` (master) and `imageProvider` (scene illustrations) preferences are already orthogonal toggles. TTS is the only AI surface still pinned to a single provider.

## Goals

1. User picks the TTS provider in Settings → OpenAI (default) or Gemini.
2. Available voices update live when the provider changes; switching provider auto-resets the voice to that provider's recommended default.
3. Server-side cache (`tts_cache`) stays correct under provider switching — no cross-provider voice-name collisions, no stale audio served for a different provider.
4. No new latency on the player-facing turn (TTS is on-demand per the existing button; no background work changes).
5. Existing campaigns behave unchanged: any pre-existing `tts_cache` rows continue to play. Users who never visit Settings stay on OpenAI.

## Non-goals (deferred)

- ❌ Anthropic TTS — Anthropic has no TTS API. Out of scope (would require a third-party fallback like ElevenLabs, separate spec).
- ❌ Per-session TTS provider override.
- ❌ A TTS-model picker in the UI (model stays env-driven: `OPENAI_TTS_MODEL`, `GEMINI_TTS_MODEL`).
- ❌ Preview/audition button in Settings ("hear this voice").
- ❌ Caching cross-provider for the same message (each `(messageId, provider, voice)` is its own row).
- ❌ Streaming the audio response (current route already returns the full `arraybuffer`; keep it).
- ❌ Server-side gating when `GEMINI_API_KEY` is unset — same lazy-fail pattern as master/image (first call throws `GEMINI_API_KEY is not set`).

## Architecture

A new `src/ai/tts/` folder replaces the current single-file `src/ai/tts.ts`:

```
src/ai/tts/
├── index.ts        — dispatcher: synthesizeSpeech({text, provider, voice})
├── voices.ts       — provider-keyed voice constants + helpers
├── openai.ts       — extracted from current tts.ts; exports synthesizeSpeechOpenAI
└── gemini.ts       — new; uses @google/genai; PCM L16 → MP3 via lamejs
```

The existing `src/lib/tts-voices.ts` is **deleted**; its single export point moves into `src/ai/tts/voices.ts`. All current imports (`@/lib/tts-voices` from `preferences.ts` and `settings-client.tsx`) are repointed.

The `tts_cache` table grows a `provider` column. Primary key becomes `(messageId, provider, voice)`. Existing rows are backfilled with `provider = 'openai'` (the only provider before this change).

User preferences gain `ttsProvider?: 'openai' | 'gemini'`. The provider PUT endpoint, on receipt of a `ttsProvider` change without an explicit `ttsVoice`, also resets `ttsVoice` to the new provider's recommended default. This keeps the stored value valid (an OpenAI voice slug like `'onyx'` is meaningless to Gemini).

The TTS GET route reads `prefs.ttsProvider` + `prefs.ttsVoice`, queries the cache for the `(messageId, provider, voice)` triple, and dispatches synthesis to the right backend on miss.

### Why this shape (key trade-offs already settled)

- **Two providers only (OpenAI + Gemini)**, no Anthropic — Anthropic ships no TTS endpoint, and routing through a third party (ElevenLabs etc.) is a separate product call. We keep the door open by making the provider a string union, but won't add a button until there's a working backend.
- **Provider added to `tts_cache` PK** chosen over a single-key cache: future Gemini voices may share a name with an OpenAI voice ("nova" is a real OpenAI voice; Gemini hasn't claimed it but might), and even today the voice name is the only disambiguator inside `tts_cache`. Without `provider` in the PK, switching providers and switching back would serve the wrong audio. Migration is straightforward (default-fill + PK rebuild).
- **No model picker UI** chosen over a dropdown: TTS models change less than master models (OpenAI's `gpt-4o-mini-tts` is the only sensible default; Gemini's `gemini-2.5-flash-preview-tts` is the only TTS endpoint). Env override is enough; UI clutter isn't worth it.
- **Auto-reset voice on provider change** chosen over silent invalid state: if the user picks Gemini while their stored `ttsVoice = 'onyx'`, the next "Listen" click would 400. Auto-reset to `'Kore'` (Gemini's documented default) keeps things working without a second click.
- **PCM→MP3 conversion server-side** chosen over storing raw PCM/WAV in `tts_cache`: the column is named `audio_mp3`, the response Content-Type is `audio/mpeg`, and every existing row is MP3. Converting Gemini's PCM L16 to MP3 with `lamejs` (pure-JS, ~50KB, runs on Node) keeps the schema and the response shape identical for both providers. Cost: ~30-50 ms per ~30 s clip on Vercel Fluid, encoded once and cached.
- **Voice list scoped to a curated set** chosen over enumerating all 30 Gemini voices: we pick ~10 voices per provider (parity with current OpenAI list). Curated voices are easier to display and keep the UI from looking lopsided. The full list is documented in `voices.ts` and easy to extend.

## Data model

### `tts_cache` (modified)

Current schema (`src/db/schema/tts-cache.ts`):

```ts
{
  messageId: uuid → session_messages.id ON DELETE CASCADE,
  voice:     text NOT NULL,
  audioMp3:  bytea NOT NULL,
  createdAt: timestamptz NOT NULL DEFAULT now(),
}
PRIMARY KEY (messageId, voice)
```

New schema:

```ts
{
  messageId: uuid → session_messages.id ON DELETE CASCADE,
  provider:  text NOT NULL,                 // 'openai' | 'gemini'
  voice:     text NOT NULL,
  audioMp3:  bytea NOT NULL,                // column name kept for migration simplicity; both providers store MP3 bytes
  createdAt: timestamptz NOT NULL DEFAULT now(),
}
PRIMARY KEY (messageId, provider, voice)
```

### Migration (drizzle-generated, manually edited if needed)

```sql
ALTER TABLE "tts_cache" ADD COLUMN "provider" text;
UPDATE "tts_cache" SET "provider" = 'openai' WHERE "provider" IS NULL;
ALTER TABLE "tts_cache" ALTER COLUMN "provider" SET NOT NULL;
ALTER TABLE "tts_cache" DROP CONSTRAINT "tts_cache_message_id_voice_pk";
ALTER TABLE "tts_cache" ADD CONSTRAINT "tts_cache_message_id_provider_voice_pk"
  PRIMARY KEY ("message_id", "provider", "voice");
```

`pnpm db:generate` produces the first half automatically. The drop+add of the PK is appended manually if drizzle-kit's diff doesn't catch it (drizzle has been hit-or-miss on PK changes — verify the generated SQL before applying).

### `users.preferences` (modified, JSONB key only — no column change)

Add to `UserPreferences` interface in `src/db/schema/users.ts`:

```ts
/** Provider for TTS synthesis. When unset, falls back to TTS_PROVIDER env (default 'openai'). */
ttsProvider?: 'openai' | 'gemini';
```

No DB migration — this is a JSONB key.

## Voice catalog

`src/ai/tts/voices.ts` (new file, replaces `src/lib/tts-voices.ts`):

```ts
export type TtsProvider = 'openai' | 'gemini';

export const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo',
  'fable', 'onyx', 'nova', 'sage', 'shimmer',
] as const;
export type OpenAIVoice = (typeof OPENAI_VOICES)[number];

export const GEMINI_VOICES = [
  'Kore',     // bright, default
  'Aoede',    // breezy
  'Puck',     // upbeat
  'Charon',   // informative
  'Fenrir',   // excitable
  'Leda',     // youthful
  'Orus',     // firm
  'Zephyr',   // bright
  'Iapetus',  // clear
  'Sadachbia',// lively
] as const;
export type GeminiVoice = (typeof GEMINI_VOICES)[number];

export type TtsVoice = OpenAIVoice | GeminiVoice;

export const DEFAULT_VOICE: Record<TtsProvider, TtsVoice> = {
  openai: 'onyx',
  gemini: 'Kore',
};

export const TTS_PROVIDERS: readonly TtsProvider[] = ['openai', 'gemini'] as const;

export function voicesFor(provider: TtsProvider): readonly TtsVoice[] {
  return provider === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES;
}

export function defaultVoice(provider: TtsProvider): TtsVoice {
  return DEFAULT_VOICE[provider];
}

export function isValidTtsProvider(v: unknown): v is TtsProvider {
  return typeof v === 'string' && (TTS_PROVIDERS as readonly string[]).includes(v);
}

export function isValidVoice(provider: TtsProvider, voice: unknown): voice is TtsVoice {
  if (typeof voice !== 'string') return false;
  return (voicesFor(provider) as readonly string[]).includes(voice);
}

/** Legacy: validates against any provider's voices. Used by the preferences PUT
 *  fast path when ttsProvider isn't being changed. */
export function isValidAnyVoice(voice: unknown): voice is TtsVoice {
  return typeof voice === 'string'
    && ((OPENAI_VOICES as readonly string[]).includes(voice)
      || (GEMINI_VOICES as readonly string[]).includes(voice));
}
```

The Gemini voice list is the documented "10 most common" subset of the ~30 voices the API supports. We can grow this list later without a schema change.

`src/lib/tts-voices.ts` is deleted in the same commit. Imports in `preferences.ts` and `settings-client.tsx` are repointed to `@/ai/tts/voices` (the same names + a few new ones).

## Provider implementations

### `src/ai/tts/openai.ts` (extracted from current `src/ai/tts.ts`)

```ts
import OpenAI from 'openai';
import type { OpenAIVoice } from './voices';

const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';

let _client: OpenAI | null = null;
let _override: OpenAI | null = null;
function getClient(): OpenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey });
  return _client;
}
export function __setOpenAIClientForTest(mock: OpenAI | null): void { _override = mock; }

export interface SynthesizeOpenAIInput {
  text: string;
  voice: OpenAIVoice;
  model?: string;
}

export async function synthesizeSpeechOpenAI(input: SynthesizeOpenAIInput): Promise<ArrayBuffer> {
  if (!input.text.trim()) throw new Error('tts: empty input');
  const client = getClient();
  const response = await client.audio.speech.create({
    model: input.model ?? TTS_MODEL,
    voice: input.voice,
    input: input.text,
    response_format: 'mp3',
  });
  return await response.arrayBuffer();
}
```

Behavior is identical to current `synthesizeSpeech` in `src/ai/tts.ts`. The test seam (`__setOpenAIClientForTest`) is new — adopting the pattern already used in `src/sessions/image-providers/openai.ts`.

### `src/ai/tts/gemini.ts` (new)

```ts
import { GoogleGenAI } from '@google/genai';
import type { GeminiVoice } from './voices';
import { encodePcmToMp3 } from './pcm-to-mp3';

const TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts';

let _client: GoogleGenAI | null = null;
let _override: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}
export function __setGeminiClientForTest(mock: GoogleGenAI | null): void { _override = mock; }

export interface SynthesizeGeminiInput {
  text: string;
  voice: GeminiVoice;
  model?: string;
}

export async function synthesizeSpeechGemini(input: SynthesizeGeminiInput): Promise<ArrayBuffer> {
  if (!input.text.trim()) throw new Error('tts: empty input');
  const client = getClient();
  const response = await client.models.generateContent({
    model: input.model ?? TTS_MODEL,
    contents: [{ role: 'user', parts: [{ text: input.text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: input.voice },
        },
      },
    },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error('tts: gemini returned no audio');
  // Gemini returns base64-encoded PCM L16 little-endian, 24kHz, mono.
  const pcmBytes = Buffer.from(inline.data, 'base64');
  return encodePcmToMp3(pcmBytes, { sampleRate: 24000, channels: 1 });
}
```

### `src/ai/tts/pcm-to-mp3.ts` (new helper)

Wraps `lamejs` so the import surface stays narrow and the rest of the code never touches the encoder API directly.

```ts
import lamejs from 'lamejs';

export interface PcmInput {
  sampleRate: 16000 | 22050 | 24000 | 44100 | 48000;
  channels: 1 | 2;
  /** Optional kbps override; default 128. */
  bitRate?: number;
}

export function encodePcmToMp3(pcm: Buffer, opts: PcmInput): ArrayBuffer {
  const { sampleRate, channels, bitRate = 128 } = opts;
  // Reinterpret bytes as Int16Array (little-endian on x64/ARM Vercel runners).
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitRate);
  const blockSize = 1152;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    const slice = samples.subarray(i, i + blockSize);
    const buf = encoder.encodeBuffer(slice);
    if (buf.length > 0) chunks.push(new Uint8Array(buf));
  }
  const flush = encoder.flush();
  if (flush.length > 0) chunks.push(new Uint8Array(flush));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
```

`lamejs` types are minimal/missing — declare module if needed:

```ts
// src/types/lamejs.d.ts
declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  const _default: { Mp3Encoder: typeof Mp3Encoder };
  export default _default;
}
```

Endianness: Node `Buffer` on Vercel Linux x64/ARM is little-endian, matching the PCM L16 little-endian Gemini emits. No swap needed. (If we later run on big-endian — we won't — guard with `os.endianness()`.)

### `src/ai/tts/index.ts` (dispatcher, new)

```ts
import type { TtsProvider, TtsVoice, OpenAIVoice, GeminiVoice } from './voices';
import { isValidVoice } from './voices';
import { synthesizeSpeechOpenAI } from './openai';
import { synthesizeSpeechGemini } from './gemini';

export interface SynthesizeInput {
  text: string;
  provider: TtsProvider;
  voice: TtsVoice;
}

export async function synthesizeSpeech(input: SynthesizeInput): Promise<ArrayBuffer> {
  if (!isValidVoice(input.provider, input.voice)) {
    throw new Error(`tts: voice "${input.voice}" not valid for provider "${input.provider}"`);
  }
  if (input.provider === 'gemini') {
    return synthesizeSpeechGemini({ text: input.text, voice: input.voice as GeminiVoice });
  }
  return synthesizeSpeechOpenAI({ text: input.text, voice: input.voice as OpenAIVoice });
}

// Re-exports for callers that only want types
export type { TtsProvider, TtsVoice } from './voices';
```

The old `src/ai/tts.ts` is **deleted**. Its only caller (`src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts`) is updated to import from `@/ai/tts`.

## Preferences plumbing

### `src/lib/preferences.ts` changes

```ts
function envDefaultTtsProvider(): TtsProvider {
  const raw = (process.env.TTS_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  // ... existing fields ...
  ttsProvider: 'openai',
  ttsVoice: 'onyx',
  // ... existing fields ...
};

export async function getResolvedPreferences(userId: string): Promise<Required<UserPreferences>> {
  const prefs = await getUserPreferences(userId);
  // ... existing resolution ...
  const ttsProvider = prefs.ttsProvider ?? envDefaultTtsProvider();
  // If stored ttsVoice doesn't match the resolved provider, fall back to that
  // provider's default. Defensive — should be prevented by the PUT validator
  // but keeps reads safe under bad data.
  const ttsVoice = prefs.ttsVoice && isValidVoice(ttsProvider, prefs.ttsVoice)
    ? prefs.ttsVoice
    : defaultVoice(ttsProvider);
  return {
    // ... existing fields ...
    ttsProvider,
    ttsVoice,
    // ... existing fields ...
  };
}
```

The `isValidTtsVoice` helper in this file (legacy, single-provider) is renamed `isValidAnyVoice` and re-exported from `@/ai/tts/voices`. Routes that need provider-aware validation use `isValidVoice(provider, voice)`.

### `src/app/api/preferences/route.ts` changes

Two new branches in `PUT`:

```ts
if ('ttsProvider' in body) {
  if (!isValidTtsProvider(body.ttsProvider)) {
    return NextResponse.json({ error: 'invalid-ttsProvider' }, { status: 400 });
  }
  patch.ttsProvider = body.ttsProvider;
  // If the caller didn't also pass a ttsVoice, reset to the new provider's default
  // so we don't leave the user with an OpenAI voice paired with Gemini provider.
  if (!('ttsVoice' in body)) {
    patch.ttsVoice = defaultVoice(body.ttsProvider);
  }
}
```

The existing `ttsVoice` branch becomes provider-aware:

```ts
if ('ttsVoice' in body) {
  if (body.ttsVoice === undefined || body.ttsVoice === null) {
    patch.ttsVoice = undefined;
  } else {
    // Resolve which provider this voice will live under: the one being set
    // in this same PUT, otherwise the one currently stored, otherwise the env default.
    const resolvedProvider =
      patch.ttsProvider
      ?? (await getUserPreferences(userId)).ttsProvider
      ?? envDefaultTtsProvider();
    if (!isValidVoice(resolvedProvider, body.ttsVoice)) {
      return NextResponse.json({ error: 'invalid-ttsVoice' }, { status: 400 });
    }
    patch.ttsVoice = body.ttsVoice;
  }
}
```

The two branches must be processed in this order so a single PUT carrying `{ ttsProvider, ttsVoice }` validates the voice against the new provider, not the old one.

## TTS API route changes

`src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts`:

```ts
import { synthesizeSpeech } from '@/ai/tts';

// ... existing auth + ownership checks ...
const prefs = await getResolvedPreferences(userId);
const provider = prefs.ttsProvider;
const voice = prefs.ttsVoice;

// Cache hit?
const [cached] = await db
  .select({ audioMp3: ttsCache.audioMp3 })
  .from(ttsCache)
  .where(and(
    eq(ttsCache.messageId, messageId),
    eq(ttsCache.provider, provider),
    eq(ttsCache.voice, voice),
  ))
  .limit(1);

// ... return cached if present ...

// Cache miss — synthesize, store, return
let audioBytes: ArrayBuffer;
try {
  audioBytes = await synthesizeSpeech({ text: message.content, provider, voice });
} catch (e) {
  // ... existing error handling ...
}

await db
  .insert(ttsCache)
  .values({ messageId, provider, voice, audioMp3: Buffer.from(audioBytes) })
  .onConflictDoNothing();
```

Response shape (Content-Type `audio/mpeg`, the X-Tts-Cache header) is unchanged.

## UI changes (Settings page)

The existing "Master voice (TTS)" Card grows a provider radio above the voice select.

```tsx
const TTS_PROVIDER_LABEL: Record<TtsProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
};

async function onTtsProviderChange(next: TtsProvider) {
  // The PUT also resets ttsVoice on the server side; mirror that locally so
  // the dropdown reflects the new provider's voices immediately.
  const nextVoice = defaultVoice(next);
  setPrefs((p) => ({ ...p, ttsProvider: next, ttsVoice: nextVoice }));
  await save({ ttsProvider: next });
}

async function onVoiceChange(e: ChangeEvent<HTMLSelectElement>) {
  const value = e.target.value;
  setPrefs((p) => ({ ...p, ttsVoice: value }));
  await save({ ttsVoice: value });
}
```

```tsx
<Card>
  <div>
    <Eyebrow>Voice</Eyebrow>
    <h2>Master voice (TTS)</h2>
    <p>Voce del master. Cambia provider per usare le voci OpenAI o Gemini.</p>
  </div>

  {/* Provider radio (new) */}
  <div style={{ display: 'flex', gap: 8 }}>
    {TTS_PROVIDERS.map((p) => (
      <button
        key={p}
        onClick={() => onTtsProviderChange(p)}
        aria-pressed={prefs.ttsProvider === p}
        disabled={busy}
        style={{ /* same shape as the master-provider radio */ }}
      >
        {TTS_PROVIDER_LABEL[p]}
      </button>
    ))}
  </div>

  {/* Voice select (existing, list now provider-driven) */}
  <select
    id="ttsVoice"
    value={prefs.ttsVoice}
    onChange={onVoiceChange}
    disabled={busy}
  >
    {voicesFor(prefs.ttsProvider).map((v) => (
      <option key={v} value={v}>{v}</option>
    ))}
  </select>
</Card>
```

`prefs.ttsProvider` is read straight from `GET /api/preferences` response (which now includes the new key). New users get `'openai'` from `DEFAULT_PREFERENCES`.

The line that currently reads *"OpenAI `gpt-4o-mini-tts`. Applies to..."* is reworded to be provider-agnostic: "Voce del master. Cambia provider per usare le voci OpenAI o Gemini." — the model slug is no longer surfaced (deemed clutter; users don't pick it anyway).

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `TTS_PROVIDER` | `openai` | Default `ttsProvider` when user hasn't picked |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTS model slug (existing) |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Gemini TTS model slug (new) |
| `GEMINI_API_KEY` | — | Required when `ttsProvider=gemini`; lazy fail at first call (existing for master/image) |
| `OPENAI_API_KEY` | — | Required when `ttsProvider=openai` (existing) |

## Behavior matrix

| `ttsProvider` (resolved) | `ttsVoice` (resolved) | API key | Outcome |
|---|---|---|---|
| `openai` | `'onyx'` | `OPENAI_API_KEY` set | Default; existing behavior |
| `openai` | invalid (e.g. `'Kore'` from old data) | — | Resolved at read time → fallback to `'onyx'` |
| `gemini` | `'Kore'` | `GEMINI_API_KEY` set | Gemini path; PCM→MP3 encode; cached |
| `gemini` | invalid (e.g. `'onyx'`) | — | Resolved at read time → fallback to `'Kore'` |
| `gemini` | (any) | `GEMINI_API_KEY` unset | First "Listen" click returns 500 with `error: 'GEMINI_API_KEY is not set'` |

## Failure modes

- **Gemini SDK throws (4xx/5xx)** → caught by the route's existing try/catch → JSON `{ error, upstreamStatus }` with `502 / 500`. Frontend's existing error toast handles it.
- **Gemini returns no audio part** → throws `tts: gemini returned no audio` → 500 from route. Logged.
- **`lamejs` throws on encoder init** (extremely rare; bad sample rate) → bubbles up; 500 from route. Logged.
- **Cache write race**: same `onConflictDoNothing` as today. With the new PK including `provider`, two concurrent requests on the same `(message, provider, voice)` triple still serialize correctly.
- **Voice reset race**: user PUTs `ttsProvider` and `ttsVoice` separately; the per-key handlers in the PUT route process `ttsProvider` first (auto-resetting voice), then `ttsVoice` overrides if the second PUT arrives later. No data corruption, just brief flicker. Not worth a transactional lock.

## Edge cases

- **User had a cached audio under `(messageId, 'onyx')` pre-migration**: backfilled to `(messageId, 'openai', 'onyx')` by the migration. Plays fine on next click.
- **User on OpenAI clicks Listen, switches to Gemini, clicks Listen on the same message**: cache miss (different `(provider, voice)`), Gemini synthesizes, both rows coexist in cache. Switching back replays the OpenAI row.
- **Bad data in `users.preferences.ttsVoice`** (e.g. user manually edited DB): `getResolvedPreferences` falls back to provider default. The TTS route never sees an invalid voice.
- **`GEMINI_TTS_MODEL` env points at a model that doesn't support audio modality**: SDK throws → route returns 502 with the SDK error. No silent failure.
- **Player session deleted while TTS in flight**: existing CASCADE handles it on next request; current in-flight request just returns its bytes (the ttsCache row insert may fail silently due to FK violation, which is fine).

## Testing

### Unit (vitest)

`tests/ai/tts/voices.test.ts` (~5 cases):
- `voicesFor('openai')` returns OpenAI list; `voicesFor('gemini')` returns Gemini list
- `defaultVoice('openai') === 'onyx'`; `defaultVoice('gemini') === 'Kore'`
- `isValidVoice('openai', 'onyx') === true`; `isValidVoice('openai', 'Kore') === false`
- `isValidVoice('gemini', 'Kore') === true`; `isValidVoice('gemini', 'onyx') === false`
- `isValidTtsProvider` accepts both, rejects others

`tests/ai/tts/openai.test.ts` (~3 cases):
- Happy path with mocked client (uses `__setOpenAIClientForTest`)
- Empty text throws
- API throws → bubbles up (preserving status)

`tests/ai/tts/gemini.test.ts` (~5 cases):
- Happy path: mocked client returns base64 PCM → encoded MP3 bytes returned
- Empty audio part → throws `tts: gemini returned no audio`
- SDK throws → bubbles up
- Voice from `GEMINI_VOICES` is passed correctly into `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`
- Test seam `__setGeminiClientForTest` round-trips cleanly

`tests/ai/tts/pcm-to-mp3.test.ts` (~2 cases):
- Encode a known PCM L16 buffer → output is non-empty, starts with MP3 frame sync (`0xFF 0xFB` or similar)
- Encoder buffer slicing handles non-multiple-of-1152 sample counts (don't lose tail samples)

`tests/ai/tts/dispatcher.test.ts` (~3 cases):
- `provider: 'openai'` dispatches to OpenAI backend
- `provider: 'gemini'` dispatches to Gemini backend
- Mismatched voice for provider throws

`tests/lib/preferences-tts.test.ts` (~3 cases):
- `getResolvedPreferences` returns `'openai'` + `'onyx'` for empty prefs
- Returns `'gemini'` + `'Kore'` when only `ttsProvider: 'gemini'` is stored
- Returns provider default when stored `ttsVoice` doesn't match stored `ttsProvider` (defensive)

### Integration (vitest, Next route handlers)

`tests/api/preferences-tts.test.ts` (~4 cases):
- PUT `{ ttsProvider: 'gemini' }` alone resets `ttsVoice` to `'Kore'`
- PUT `{ ttsProvider: 'gemini', ttsVoice: 'Kore' }` validates the voice against Gemini, succeeds
- PUT `{ ttsProvider: 'gemini', ttsVoice: 'onyx' }` returns 400 `invalid-ttsVoice`
- PUT `{ ttsProvider: 'invalid' }` returns 400 `invalid-ttsProvider`

`tests/api/tts-route.test.ts` (~4 cases — extends existing if any, otherwise new):
- Cache hit on `(messageId, 'openai', 'onyx')` returns cached bytes with `X-Tts-Cache: HIT`
- Cache hit on `(messageId, 'gemini', 'Kore')` returns cached bytes (different row)
- Cache miss on Gemini path: mocked `synthesizeSpeech` returns bytes; row inserted; `X-Tts-Cache: MISS`
- Switching `ttsProvider` between two requests serves two different cache rows for the same message

### E2E (playwright) — optional, follow-up

Not required for ship. Manual verification:
1. Settings → switch to Gemini → voice list updates → save persists → reload page → still on Gemini.
2. Chat → Listen on a master message → Gemini audio plays.
3. Switch back to OpenAI → Listen on the same message → OpenAI audio plays (different cache row).

### Existing tests that need updating

- `tests/api/tts-cache.test.ts` — schema changed: PK is now `(messageId, provider, voice)`; all `.values({ messageId, voice, audioMp3 })` inserts need a `provider` field; new "switching provider creates a separate row" case added here.
- `tests/lib/tts-playback.test.ts` — no changes (touches the in-page audio coordinator, not the cache/synth).
- Any `import ... from '@/lib/tts-voices'` — repointed to `'@/ai/tts/voices'`.

### Coverage targets

Total expected: existing ~280 + new ~30 = ~310. The only existing test failure on day one (before adapting it) is `tests/api/tts-cache.test.ts` — fixed in the same task that ships the migration.

## Migration & rollout

1. Drop a feature branch via worktree (project-local `.worktrees/`).
2. Tasks executed via `subagent-driven-development` (per writing-plans handoff).
3. Migration applied via `pnpm db:migrate` against Neon. Rollback path: revert the migration SQL (drop new PK, drop column, restore old PK).
4. After deploy, existing users with no `ttsProvider` stay on `'openai'` (env default). No user-facing change unless they visit Settings.

## Open questions / risks

- **`lamejs` maintenance status.** Last published 2017. Pure JS, no native deps, 50KB. Works on Node 20+. The risk is "we discover a bug" — mitigated by isolating the encoder behind `pcm-to-mp3.ts`. Alternative if it bites: switch to `node-lame` (native, slower) or change the cache schema to store WAV (44-byte RIFF header + raw PCM, no encoding).
- **Gemini TTS preview status.** `gemini-2.5-flash-preview-tts` is a preview model. Endpoint shape and pricing may shift. The implementation is one file (`src/ai/tts/gemini.ts`) so a follow-up adapter is cheap if Google moves the API.
- **Gemini voice list freshness.** We pin 10 names; Google may rename or deprecate one. Mitigation: invalid stored voices fall back to default at read time, so a deprecated voice degrades gracefully (no broken UI). On Gemini's side, an invalid `voiceName` returns a 400 — surfaces to user as a TTS error toast.
- **Cost asymmetry.** Gemini TTS preview pricing isn't fully published; OpenAI TTS is well-known ($15/1M chars for `gpt-4o-mini-tts`). Users who switch to Gemini may see different bill amounts. We don't gate on cost — same posture as the master/image provider toggle.
- **Endianness assumption.** PCM L16 from Gemini is documented little-endian; Vercel Linux runners are LE. If a non-LE runtime ever ships, `pcm-to-mp3.ts` would need a swap. Document the assumption in the helper's comment.
