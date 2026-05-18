# Shared TTS + scene-image generation (single-flight, broadcast)

**Date:** 2026-05-15
**Status:** Approved design — ready for implementation plan
**Author:** brainstorming session

## Problem

When N players sit in the same campaign session and the master finishes
a turn, **each viewer independently triggers TTS synthesis** for the
narration (manually via "Listen", or automatically via the per-viewer
autoplay toggle). Today:

- The `tts_cache` PK is `(messageId, voice, model)` so the *first*
  request to land pays the provider call and persists the bytes; any
  subsequent request hits the cache. But if **two clients click within
  the same second**, both see "cache miss" simultaneously, both call
  the provider, both insert (one wins, one no-ops on `ON CONFLICT DO
  NOTHING`) — we pay for the redundant API call.
- For scene images the situation is worse: clicking "Generate image"
  on two clients triggers two parallel `generateAndPersist` calls. The
  optimistic version guard protects the database (one ends with
  `race_lost`), but **the loser still spent ~10-30s of provider time +
  cost** before discovering it lost.
- Worst: while one client is waiting (3-5s for TTS, 10-30s for image),
  **the other clients see no indication** that the operation is in
  flight — so an impatient player clicks "Listen" twice, triggering
  redundant work.

## Goal

Make TTS and scene-image generation **single-flight per content key**:
the first request locks the job, subsequent requests piggy-back on the
in-flight job. Broadcast `pending` → `ready`/`failed` events over the
existing SSE channel so every connected client sees a shared spinner
and the same outcome at the same time.

## Scope decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| TTS playback model | Single-flight synthesis + audio bytes distributed; **playback per-viewer** (each client decides if/when to play). No "synchronized radio". |
| In-flight UI | All clients in the session show a shared spinner ("Generating…") while a job is in flight, regardless of who clicked. |
| Error UX | Transient error (~5s) shown to everyone, then UI auto-resets so the next click triggers a fresh attempt. |
| Orphan cleanup | TTL-based opportunistic re-claim (60s); no dedicated cron. |
| Cross-session sharing | Out of scope; everything is per-session. |
| Sync playback position | Out of scope (per-viewer playback was chosen). |

## Architecture

Single-flight via Postgres status table + advisory pattern (`INSERT …
ON CONFLICT DO NOTHING`), broadcast via the existing
`pg_notify('session_<id>', …)` → SSE pipeline.

```
 Client A (clicks)     Server (Fluid Compute)     Postgres        Client B (also clicks)
      │                      │                       │                     │
      │── POST /tts ────────▶│                       │                     │
      │                      │── INSERT pending ────▶│  inserted ✓         │
      │                      │   ON CONFLICT NOTHING │  (Client A = leader)│
      │                      │◀──────────────────────│                     │
      │                      │── NOTIFY tts-pending ▶│                     │
      │                      │                       │── tts-pending ────▶ Client B (shows spinner)
      │                      │── call provider ─...  │                     │
      │                      │   (3-5s)              │                     │
      │                      │                       │                     │── POST /tts ──┐
      │                      │                       │◀─ INSERT pending ───│              │
      │                      │                       │   CONFLICT (already)│              │
      │                      │                       │── follower wait ───▶│ (waitForReady)
      │                      │── UPDATE ready+bytes ▶│                     │
      │                      │── NOTIFY tts-ready ──▶│                     │
      │◀── 200 bytes ────────│                       │── tts-ready ──────▶ Client B
      │                      │                       │                     │── GET /tts (HIT)
      │                      │                       │                     │◀──── 200 bytes
```

For images: same pattern, key is `(sessionId, expectedVersion)` and
state lives on `session_state` (`scene_image_pending` flag) plus the
existing version-guarded UPDATE in `generateAndPersist`.

## Data model

### `tts_cache` extension (1 migration)

```sql
ALTER TABLE tts_cache
  ADD COLUMN status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('pending', 'ready', 'failed')),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN failed_reason text,
  ALTER COLUMN audio_mp3 DROP NOT NULL,
  ALTER COLUMN mime_type DROP NOT NULL;
```

State meaning:
- `status='ready'`, `audio_mp3 IS NOT NULL`: cache hit, current
  behavior (default for existing rows).
- `status='pending'`, `audio_mp3 IS NULL`: a leader is currently
  synthesizing. `started_at` is the lock timestamp.
- `status='failed'`, `audio_mp3 IS NULL`: most recent attempt failed.
  `failed_reason` carries the provider error message.

PK stays `(message_id, voice, model)`.

### `session_state` extension (same migration)

```sql
ALTER TABLE session_state
  ADD COLUMN scene_image_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN scene_image_pending_at timestamptz,
  ADD COLUMN scene_image_failed_reason text;
```

`scene_image_pending=true` ⇒ a leader is generating; clients show
shared spinner. On success → `pending=false`,
`sceneImageVersion++`, bytes saved (existing flow). On failure →
`pending=false`, `failed_reason` valued.

### `NotifyPayload` extension

```ts
// src/sessions/notify.ts
export type NotifyPayload =
  // …existing
  | { type: 'tts-pending'; messageId: string }
  | { type: 'tts-ready'; messageId: string }
  | { type: 'tts-failed'; messageId: string; reason: string }
  | { type: 'image-pending'; messageId: string }
  | { type: 'image-ready' }
  | { type: 'image-failed'; reason: string };
```

## Server: try-claim + leader/follower

New helper `src/sessions/tts-job.ts`:

```ts
export type ClaimResult = 'leader' | 'follower' | 'ready';

export async function tryClaimTtsJob(
  messageId: string, voice: string, model: string, provider: string,
): Promise<{ result: ClaimResult; existing?: TtsCacheRow }> {
  // 1. Try-insert pending row. Conflict on PK = someone else got there.
  const inserted = await db.insert(ttsCache).values({
    messageId, voice, model, provider,
    status: 'pending', startedAt: new Date(),
    audioMp3: null, mimeType: null,
  }).onConflictDoNothing().returning();
  if (inserted.length > 0) return { result: 'leader' };

  // 2. Row exists. Read current state.
  const [row] = await db.select().from(ttsCache).where(/* PK */).limit(1);
  if (row.status === 'ready' && row.audioMp3) return { result: 'ready', existing: row };

  // 3. Pending older than TTL (60s) ⇒ orphan. Try to re-claim.
  const TTL_MS = 60_000;
  const isStale = row.startedAt && Date.now() - row.startedAt.getTime() > TTL_MS;
  if (isStale || row.status === 'failed') {
    const updated = await db.update(ttsCache)
      .set({ status: 'pending', startedAt: new Date(), audioMp3: null, mimeType: null, failedReason: null })
      .where(and(/* PK */, eq(ttsCache.startedAt, row.startedAt!)))  // optimistic guard
      .returning();
    if (updated.length > 0) return { result: 'leader' };
    // someone else won the re-claim race; fall through as follower
  }

  return { result: 'follower', existing: row };
}
```

Symmetrical helper `tryClaimImageJob(sessionId)` updates
`session_state` conditionally:

```sql
UPDATE session_state
SET scene_image_pending = true,
    scene_image_pending_at = now(),
    scene_image_failed_reason = NULL
WHERE session_id = $1
  AND (
    scene_image_pending = false
    OR scene_image_pending_at < now() - interval '60 seconds'
    OR scene_image_failed_reason IS NOT NULL
  )
RETURNING session_id;
```

Row returned ⇒ leader. No row ⇒ follower.

### Route flow (TTS)

```ts
// src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts
const claim = await tryClaimTtsJob(messageId, voice, model, provider);

if (claim.result === 'ready') return cacheHitResponse(claim.existing!);

if (claim.result === 'leader') {
  await notifySession(sessionId, { type: 'tts-pending', messageId });
  try {
    const out = await synthesizeSpeech({ text, provider, voice, model });
    await db.update(ttsCache).set({
      status: 'ready', audioMp3: Buffer.from(out.bytes), mimeType: out.mimeType,
    }).where(/* PK */);
    await notifySession(sessionId, { type: 'tts-ready', messageId });
    return audioResponse(out.bytes, out.mimeType);
  } catch (e) {
    await db.update(ttsCache).set({ status: 'failed', failedReason: errStr(e) }).where(/* PK */);
    await notifySession(sessionId, { type: 'tts-failed', messageId, reason: errStr(e) });
    return errorResponse(e);
  }
}

// follower: wait for leader to finish
return await waitForReady(sessionId, messageId, voice, model);
```

`waitForReady(sessionId, messageId, voice, model)`:

1. Open a `LISTEN session_<sessionId>` client via `createListenClient()`
   (uses `DATABASE_URL_UNPOOLED` per existing convention — pgbouncer
   doesn't support LISTEN).
2. Race against a 30s timeout and a 2s-interval DB poll for
   `status='ready'|'failed'`.
3. On `tts-ready` for our `messageId`: read bytes from cache, return
   audio response with `X-Tts-Cache: FOLLOWER`.
4. On `tts-failed`: return error response mirroring the leader's
   failure.
5. On timeout: return 504 with `error: 'tts-follower-timeout'`. The
   client surfaces a transient error and the user can retry; the
   retry's `tryClaim` will see the now-stale lock and re-claim.

### Route flow (image)

```ts
// src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts
const claim = await tryClaimImageJob(sessionId);

if (!claim.isLeader) {
  // follower path: wait for image-ready / image-failed
  return await waitForImageReady(sessionId);
}

await notifySession(sessionId, { type: 'image-pending', messageId });
try {
  const result = await generateAndPersist(...);  // existing
  if (result.ok) {
    await db.update(sessionState).set({ scene_image_pending: false }).where(...);
    await notifySession(sessionId, { type: 'image-ready' });
    return NextResponse.json({ version: result.version });
  }
  // result.ok === false
  await db.update(sessionState).set({
    scene_image_pending: false,
    scene_image_failed_reason: result.reason,
  }).where(...);
  await notifySession(sessionId, { type: 'image-failed', reason: result.reason });
  return errorResponse(result);
} catch (e) {
  await db.update(sessionState).set({ scene_image_pending: false, scene_image_failed_reason: errStr(e) }).where(...);
  await notifySession(sessionId, { type: 'image-failed', reason: errStr(e) });
  throw e;
}
```

`waitForImageReady` is the symmetric LISTEN+poll wait for the image
notification. On `image-ready`, returns `{ version }` (read from
`session_state` via the follower's existing `/state` refresh — the
endpoint can just return the new version number).

## Client: shared pending state + transient errors

### `useSessionStream` extension

Add two stateful fields, exposed via the snapshot or as standalone
returns:

```ts
const [ttsPending, setTtsPending] = useState<Set<string>>(new Set());
const [imagePending, setImagePending] = useState(false);
const [ttsErrors, setTtsErrors] = useState<Map<string, string>>(new Map());
const [imageError, setImageError] = useState<string | null>(null);

// In the SSE handler:
case 'tts-pending':
  setTtsPending(prev => new Set(prev).add(ev.messageId));
  setTtsErrors(prev => { const m = new Map(prev); m.delete(ev.messageId); return m; });
  break;
case 'tts-ready':
  setTtsPending(prev => { const n = new Set(prev); n.delete(ev.messageId); return n; });
  break;
case 'tts-failed':
  setTtsPending(prev => { const n = new Set(prev); n.delete(ev.messageId); return n; });
  setTtsErrors(prev => new Map(prev).set(ev.messageId, ev.reason));
  setTimeout(() => setTtsErrors(p => { const m = new Map(p); m.delete(ev.messageId); return m; }), 5000);
  break;
case 'image-pending':
  setImagePending(true);
  setImageError(null);
  break;
case 'image-ready':
  setImagePending(false);
  void refetch();   // pull new state with version+bytes
  break;
case 'image-failed':
  setImagePending(false);
  setImageError(ev.reason);
  setTimeout(() => setImageError(null), 5000);
  break;
```

The returned shape adds `ttsPending`, `imagePending`, `ttsErrors`,
`imageError`.

### `TtsButton`

`src/components/game/tts-button.tsx`: accept a new prop
`sharedPending: boolean` and `sharedError: string | null` (parent
passes `ttsPending.has(messageId)` and
`ttsErrors.get(messageId) ?? null`). Update the visual state logic:

- `sharedPending || state === 'loading'` ⇒ render spinner + "Generando…"
- `sharedError` non-null ⇒ render `Failed` (parent clears it after 5s)
- Else fall through to current logic (playing / idle)

When `sharedPending` flips to false (from true), if the previous local
state was `loading` due to a follower fetch, the existing fetch
resolves naturally (it was waiting at `waitForReady` server-side); no
additional client-side bookkeeping needed.

### Autoplay coordinator (in `game-client.tsx`)

When a new `message` event arrives and `ttsAutoplay` is true on the
viewer, the existing coordinator already kicks off a `fetch /tts` for
that messageId. With single-flight:

- If no other client is generating, this fetch becomes the leader
  (insert succeeds).
- If another autoplay-enabled client has already fired its leader
  fetch, this client's fetch becomes a follower and resolves when
  the leader finishes — same bytes, ~no extra latency.

No code change needed in the coordinator; the server-side
`tryClaimTtsJob` handles the coalescing transparently.

### Image "Generate" button

Wherever the image-generate button lives (in the narrative-pane area):
accept `imagePending: boolean` and `imageError: string | null` props.
Same pattern: pending ⇒ spinner + disabled; error ⇒ transient
"Generation failed" toast/inline + auto-clear after 5s.

## Edge cases

- **Empty pending row from old data**: `status='ready'` is the new
  default for existing rows; no migration of data needed.
- **Leader crash mid-flight**: the row stays `pending` until TTL (60s)
  expires; next requester re-claims and tries again. No data
  corruption — the row gets overwritten with the new attempt's bytes.
- **Race on re-claim**: two requesters both see a stale `pending`;
  both try `UPDATE … WHERE started_at = $stale`. PostgreSQL
  serializes; one row affected, the other zero. Loser becomes
  follower.
- **Network race on follower**: follower opens LISTEN *after* the
  leader has already emitted NOTIFY → it misses the event. Mitigation:
  after opening LISTEN, the follower polls the DB once immediately;
  thereafter relies on the LISTEN events. The 2s poll loop is a
  belt-and-suspenders fallback.
- **TTS cache invalidation on voice/model change**: not a regression
  vs. today — `(messageId, voice, model)` is the PK, switching voice
  produces a fresh job; old `ready` rows stay around as before.
- **Multiple `pending` rows per message under different voices**: the
  PK includes voice/model, so two clients with two different voices
  on the same campaign session would each be their own leader. This
  should not happen because voice/model are campaign-scoped (Task
  from previous spec) — every viewer reads the same triple. Defensive:
  no special handling needed; if it ever happens, both jobs run
  independently with their own keys.

## Testing

### Unit (Vitest)

- `tryClaimTtsJob` paths:
  - empty cache → returns `'leader'`
  - existing `ready` row → returns `'ready'` with row data
  - existing `pending` row, fresh → returns `'follower'`
  - existing `pending` row, stale (>60s) → returns `'leader'`
    (re-claim path)
  - existing `failed` row → returns `'leader'` (re-claim path)
- `tryClaimImageJob` symmetrical.
- Client transient error auto-clear: after 5s the `ttsErrors` Map
  entry for the failed messageId is removed.

### Integration (Vitest + Postgres)

- Two concurrent `tryClaimTtsJob` calls for same key: exactly one
  returns `'leader'`, the other `'follower'`. Both find `'ready'`
  after the leader finishes.
- Provider mock: leader call count == 1 when 5 simulated callers
  hit the same key within 100ms.
- Image variant: 2 concurrent `POST /scene-image` ⇒ provider mock
  called once; the leader returns `{ version: N+1 }`; the follower,
  after `waitForImageReady` resolves, returns the same `{ version:
  N+1 }` (read from the post-update `session_state` row).
- Orphan: pre-insert a `pending` row with `started_at = now() -
  120s`; new call re-claims successfully.
- Failure path: provider throws → row updated to `failed` with
  reason → `tts-failed` NOTIFY emitted → follower receives error
  response.

### E2E (Playwright, gated on `CLERK_TESTING_TOKEN_USER_ID`)

- Two browser contexts (same campaign session, autoplay OFF on both).
  On context A click "Listen". On context B verify spinner appears
  within 1s. After ~3-5s, context B sees the button return to
  "Listen" (cache populated). Click on B → audio plays instantly
  (cache HIT).
- Same for image: click "Generate image" on A → B sees spinner →
  B's pulsante torna disabilitato finché version bump arriva via
  refetch.

## Non-goals

- Synchronized playback position (pause-shared, scrub-shared).
- Cross-session pub/sub or sharing of cache rows.
- Replacing Postgres NOTIFY with WebSocket / Redis pub/sub.
- A formal job queue (BullMQ, Vercel Queues) — single-flight via
  `INSERT … ON CONFLICT` is sufficient at the scale of one job per
  message per campaign.
- Retry-with-backoff on transient provider errors — out of scope
  for this design; the client triggers manual retry.
- Pre-warming TTS during master streaming (could be a future
  optimization).
