# Scene Image Generation — Design

**Status:** Approved (spec)
**Author:** alessio + Claude
**Date:** 2026-05-03

## Goal

The master can generate an illustration of the current scene and have it appear in the right-hand "Scene" panel of the session view. The image is *not* regenerated every turn — the master decides when (combat start, location change, dramatic event). The feature is opt-in per user, and the artistic style is configurable, defaulting to a colored pastel drawing.

## Architecture (one paragraph)

A new tool `generate_scene_image(visualPrompt)` is registered in the master's tool set only when the user has enabled image generation. The pure handler returns `{ ok: true, data: { status: 'queued' } }` and emits a `queue_scene_image` mutation carrying the prompt verbatim. The applicator handles that mutation by resolving the user's style preset, computing `nextVersion = current + 1`, and scheduling the actual OpenAI image call via `waitUntil(...)` — so the transaction commits and the master keeps narrating without blocking the chat. When the image is ready, the background job writes the PNG bytes plus the bumped version to three new columns on `session_state` in its own UPDATE. The existing `/api/sessions/[id]/state` SSE channel — which already polls and diffs the session-state row every 1.5s — picks up the version bump and pushes a new snapshot to the client. The client renders the image via a new `GET /api/sessions/[id]/scene-image` endpoint, using the version as a cache-busting query parameter so the browser refetches only when the version changes. Latest-only: each new image overwrites the previous one. Failure is silent: the version only increments on success, so the panel never shows a broken intermediate state.

## Tech Stack

- OpenAI `gpt-image-1` (`openai.images.generate`) — already wired via `OPENAI_API_KEY` for TTS.
- `waitUntil` from `@vercel/functions` — extends function execution past response close on Vercel. Add `@vercel/functions` to dependencies if not already present.
- Postgres `bytea` for image bytes (mirrors existing `tts_cache` pattern).
- Drizzle migration via `drizzle/0007_*.sql`.

## Data Model

### Migration `drizzle/0007_scene_image.sql`

Three new columns on `session_state`:

```sql
ALTER TABLE session_state
  ADD COLUMN scene_image_data       bytea       NULL,
  ADD COLUMN scene_image_prompt     text        NULL,
  ADD COLUMN scene_image_version    integer     NOT NULL DEFAULT 0;
```

Drizzle schema in `src/db/schema/session-state.ts`:

```ts
sceneImageData: customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})('scene_image_data'),
sceneImagePrompt: text('scene_image_prompt'),
sceneImageVersion: integer('scene_image_version').notNull().default(0),
```

The bytea custom type is reused from `tts-cache.ts` — extract into a shared `src/db/types.ts` to avoid duplication.

### `UserPreferences` extension (`src/db/schema/users.ts`)

```ts
/** When true, registers generate_scene_image tool for the master. Default false. */
imageGenerationEnabled?: boolean;
/** Style preset slug. Default 'pastel'. 'custom' uses imageStyleCustom. */
imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
/** Free-text style description, used only when imageStylePreset === 'custom'. */
imageStyleCustom?: string;
```

`getResolvedPreferences` defaults: `imageGenerationEnabled: false`, `imageStylePreset: 'pastel'`, `imageStyleCustom: ''`.

## Style Resolution

A pure helper in `src/ai/master/image-style.ts`:

```ts
const PRESETS: Record<Exclude<ImageStylePreset, 'custom'>, string> = {
  pastel:    'soft colored pastel drawing, hand-drawn texture, gentle lighting',
  watercolor:'loose watercolor painting, wet edges, muted palette',
  oil:       'oil painting on canvas, painterly brushstrokes, classical lighting',
  ink:       'black ink illustration, hatched shadows, fantasy book engraving',
  photo:     'cinematic photograph, dramatic lighting, shallow depth of field',
};

export function resolveStyleText(prefs: UserPreferences): string {
  if (prefs.imageStylePreset === 'custom') {
    return (prefs.imageStyleCustom ?? '').trim() || PRESETS.pastel;
  }
  return PRESETS[prefs.imageStylePreset ?? 'pastel'];
}

export function buildImagePrompt(visualPrompt: string, styleText: string): string {
  return `${visualPrompt.trim()}. Art style: ${styleText}. No text, no watermarks.`;
}
```

## Tool

### Definition (`src/engine/tools/index.ts`)

Registered conditionally based on user preferences. The tool list is built per-request using a `buildToolDefinitions(prefs)` helper:

```ts
{
  name: 'generate_scene_image',
  description: 'Generate an illustration of the current scene. Use sparingly — only when the visual context meaningfully shifts (combat begins, the party enters a new location, a dramatic event reshapes the scene). The image is generated asynchronously and appears in the Scene panel a few seconds after this call returns. Do NOT call more than once every ~3-5 turns. Write the visualPrompt in English.',
  input_schema: {
    type: 'object',
    required: ['visualPrompt'],
    properties: {
      visualPrompt: {
        type: 'string',
        description: 'A vivid English description of the scene to draw: subjects, action, setting, atmosphere, lighting. Do NOT include style/medium — that is added separately.',
      },
    },
  },
}
```

### Handler (`src/engine/tools/handlers.ts`)

The handler stays pure — only the master-supplied prompt is encoded into a marker mutation. The DB + OpenAI side-effects (style resolution, version computation, image generation) live entirely in the applicator and the background job, where I/O is allowed.

Pure handler:

```ts
generate_scene_image: (state, input) => {
  const visualPrompt = String(input.visualPrompt ?? '').trim();
  if (!visualPrompt) {
    return { ok: false, error: 'invalid_visualPrompt', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    rolls: [],
    mutations: [{ op: 'queue_scene_image', visualPrompt }],
    data: { status: 'queued' },
  };
},
```

The `Mutation` type in `src/engine/types.ts` gains:

```ts
| { op: 'queue_scene_image'; visualPrompt: string }
```

`applicator.ts` `case 'queue_scene_image'` (inside the existing transaction):
1. Looks up `sessions.userId` for the current `sessionId`, then `users.preferences` for that user.
2. Calls `resolveStyleText(prefs)` to get the style string.
3. Reads the current `scene_image_version`, computes `nextVersion = current + 1`.
4. Calls `waitUntil(generateAndPersist(sessionId, visualPrompt, styleText, nextVersion))` — `waitUntil` is imported from `@vercel/functions`.
5. Returns. The applicator does NOT bump the version itself — that happens inside the async job on success.

### Background job (`src/sessions/scene-image-job.ts`)

```ts
export async function generateAndPersist(
  sessionId: string,
  visualPrompt: string,
  styleText: string,
  expectedVersion: number,
): Promise<void> {
  const fullPrompt = buildImagePrompt(visualPrompt, styleText);
  try {
    const res = await openai.images.generate({
      model: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1',
      prompt: fullPrompt,
      size: '1024x1024',
      quality: 'high',
      response_format: 'b64_json',
    });
    const b64 = res.data[0]?.b64_json;
    if (!b64) throw new Error('image_response_empty');
    const bytes = Buffer.from(b64, 'base64');

    // Conditional update: only bump if our expectedVersion is still the next.
    // Guards against two concurrent jobs racing.
    await db.update(sessionState)
      .set({ sceneImageData: bytes, sceneImagePrompt: visualPrompt, sceneImageVersion: expectedVersion })
      .where(and(eq(sessionState.sessionId, sessionId), eq(sessionState.sceneImageVersion, expectedVersion - 1)));
  } catch (e) {
    console.error('[scene-image] generation failed', { sessionId, error: e });
    // Silent: version stays at expectedVersion - 1, panel keeps last image.
  }
}
```

The applicator branch wires it together. `loadContext` (already at the top of `applyMutations`) is extended to also fetch `userId` so we don't repeat the sessions-row lookup:

```ts
// loadContext now selects { userId, characterId, hpMax }
// case 'queue_scene_image' (inside applyMutations transaction):
import { waitUntil } from '@vercel/functions';
import { getUserPreferences } from '@/lib/preferences';
import { resolveStyleText } from '@/ai/master/image-style';
import { generateAndPersist } from '@/sessions/scene-image-job';

const prefs = await getUserPreferences(ctx.userId);
if (!prefs.imageGenerationEnabled) break; // toggle was flipped between tool registration and apply — silently skip
const styleText = resolveStyleText(prefs);
const [stateRow] = await tx.select({ v: sessionStateTable.sceneImageVersion }).from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
const nextVersion = (stateRow?.v ?? 0) + 1;
waitUntil(generateAndPersist(sessionId, m.visualPrompt, styleText, nextVersion));
```

Note: `waitUntil` registers the promise with the Vercel function runtime; it does NOT block the transaction. The `applyMutations` tx commits normally, then the image job runs in the background and writes its own UPDATE outside the original transaction.

## Endpoint

`GET /api/sessions/[id]/scene-image`:

- Auth check (Clerk): owner only.
- Reads `scene_image_data` + `scene_image_version` from `session_state`.
- If `version === 0` or `data === null`: `404`.
- Returns `image/png` with headers:
  - `Cache-Control: private, max-age=0, must-revalidate`
  - `ETag: "v${version}"`
- Honors `If-None-Match` → `304 Not Modified` when matching.

The client URL: `/api/sessions/${sessionId}/scene-image?v=${version}`. The `?v=` is for cache busting (browser sees a new URL → refetches); the ETag is belt-and-suspenders for the same-version case.

## SSE Snapshot

The existing `/api/sessions/[id]/state` SSE diffs the JSON snapshot. The new bytea column would balloon every snapshot to ~1MB. Solution: the snapshot route **omits** `sceneImageData` from the payload — only `sceneImageVersion` and `sceneImagePrompt` are sent. The diff comparison naturally still detects version changes. Implementation: replace the bare `db.select().from(sessionState)` with an explicit column projection that excludes the bytea.

## UI

### Scene panel (`src/components/game/mechanics-pane.tsx`)

```tsx
<section>
  <Eyebrow style={{ marginBottom: 6 }}>Scene</Eyebrow>
  {state.sceneImageVersion > 0 && (
    <img
      src={`/api/sessions/${sessionId}/scene-image?v=${state.sceneImageVersion}`}
      alt={state.sceneImagePrompt ?? 'Scene illustration'}
      style={{
        width: '100%',
        aspectRatio: '1 / 1',
        objectFit: 'cover',
        borderRadius: 8,
        border: '1px solid var(--border)',
        marginBottom: 8,
        display: 'block',
      }}
    />
  )}
  <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
    {state.scene || 'No scene set yet.'}
  </div>
</section>
```

`MechanicsPane` gains a `sessionId: string` prop, threaded from `GameClient`.

### Settings (`src/app/(authed)/settings/settings-client.tsx`)

New section under existing AI settings:

```
Scene images
  [✓] Generate scene images          (toggle, off by default)

  Image style    [Pastel drawing  ▾]
  ┌─ when "Custom…" selected ─────────────────────┐
  │ Custom prompt: [textarea, 2 rows]            │
  └───────────────────────────────────────────────┘
```

Preset dropdown options (label → slug):
- "Pastel drawing" → `pastel` (default)
- "Watercolor" → `watercolor`
- "Oil painting" → `oil`
- "Ink illustration" → `ink`
- "Cinematic photo" → `photo`
- "Custom…" → `custom`

The textarea is rendered only when `preset === 'custom'`. Saving uses the existing `PATCH /api/preferences` flow.

## System Prompt Update

`buildMasterSystemPrompt` accepts a new flag `imageGenerationEnabled: boolean`. When true, append a section to the prompt:

```
## Scene illustrations

You can generate an illustration of the current scene with the
generate_scene_image tool. Use it sparingly — appropriate moments are:
- the start of a combat,
- the party arriving at a new significant location,
- a dramatic event reshaping the visible scene.

Do NOT call this tool more than once every 3-5 turns. The visualPrompt
must be in English, vivid, concrete: subjects, action, setting, light,
atmosphere. The art style is configured by the player and added
automatically — do NOT include style words ("watercolor", "cartoon",
"realistic") in your prompt.
```

When false, the section is omitted and the tool is not in `TOOL_DEFINITIONS`.

## Error Handling

| Failure | Behavior |
|---|---|
| OpenAI API error / timeout | log + version stays at previous; panel shows last image (or empty). No user-facing error. |
| OpenAI content-policy block | same as above (silent). |
| `OPENAI_API_KEY` missing | `enqueueSceneImageJob` no-ops with a warn log. The tool registration step still gates on `prefs.imageGenerationEnabled`, but missing key is a deploy-config bug, not a runtime user error. |
| User disables mid-session | tool stops being registered for next turn; existing image persists. |
| Concurrent jobs (rare) | the conditional `WHERE sceneImageVersion = expectedVersion - 1` makes the second job's update a no-op. |
| `scene_image_data` is non-null but `version === 0` | impossible in normal flow; the GET endpoint treats `version === 0` as 404 regardless. |

## Tests

| File | Coverage |
|---|---|
| `tests/ai/master/image-style.test.ts` | `resolveStyleText` returns each preset, falls back to pastel on empty custom, trims whitespace. `buildImagePrompt` composes correctly, handles trailing punctuation in visualPrompt. |
| `tests/engine/tools/generate-scene-image.test.ts` | Handler returns `{ ok: true, data: { status: 'queued' } }` and emits a `queue_scene_image` mutation carrying the visualPrompt verbatim. Empty/whitespace input → `ok: false, error: 'invalid_visualPrompt'`. |
| `tests/sessions/scene-image-applicator.test.ts` | Applicator branch resolves the user's style from prefs, calls `waitUntil` exactly once with the right `(sessionId, visualPrompt, styleText, nextVersion)`. When `imageGenerationEnabled === false` (toggle flipped), the branch no-ops without calling `waitUntil`. |
| `tests/sessions/scene-image-job.test.ts` | `generateAndPersist` with mocked OpenAI client: success path bumps version + writes bytes; failure path (API error, content policy, empty response) leaves DB untouched; race-condition test where expectedVersion is stale → conditional UPDATE no-ops. |
| `tests/app/api/sessions/scene-image-route.test.ts` | GET returns 404 when version=0, 200 PNG with ETag when version>0, 304 on If-None-Match match, 401 unauth, 403 wrong owner. |
| Existing `tests/sessions/use-session-state.test.ts` (if present, otherwise add) | Snapshot omits `sceneImageData` bytea field. |
| Manual smoke | Toggle on in settings, run a turn that triggers combat, verify image appears within ~30s, verify panel keeps text + image, verify toggle off stops registration. |

## Out of Scope (v1)

- History / gallery of past scene images (Option B in brainstorming, deferred).
- Showing a "generating…" loading state (we picked the magic-arrival pattern).
- Quota / rate-limit enforcement beyond the system-prompt nudge ("once every 3-5 turns").
- Manual "regenerate this image" UI control for the player.
- Per-session style override (lives only on user prefs).
- Vercel Blob storage migration (revisit if DB size becomes a concern — at ~500KB-1MB per image and only the latest persisted, this stays trivial).
