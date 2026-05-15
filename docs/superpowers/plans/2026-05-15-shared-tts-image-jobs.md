# Shared TTS + scene-image jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coalesce concurrent TTS and scene-image generation requests in multiplayer so the provider is called once per `(messageId,voice,model)` (TTS) or `(sessionId,version)` (image); broadcast `pending`/`ready`/`failed` events over the existing SSE channel so every connected client in the campaign session sees a shared spinner and the same outcome.

**Architecture:** Single-flight via Postgres status column on `tts_cache` and `session_state` + try-claim INSERT/UPDATE with TTL re-claim of orphans. Leader does the provider call and emits `pg_notify`; followers do a LISTEN+poll wait against the same channel that already powers session SSE. UI subscribes to new event types and renders a campaign-wide spinner / transient error per message.

**Tech Stack:** Next.js App Router 16, Drizzle ORM (Postgres), Clerk auth, Postgres LISTEN/NOTIFY, Vitest (unit + integration), Playwright (E2E). Scripts: `pnpm test`, `pnpm typecheck`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm test:e2e`.

**Spec:** `docs/superpowers/specs/2026-05-15-shared-tts-image-jobs-design.md`

---

## File Structure

**Create:**
- `drizzle/0032_<generated-name>.sql` — schema migration
- `drizzle/meta/0032_snapshot.json` — Drizzle-generated
- `src/sessions/job-claims.ts` — `tryClaimTtsJob` + `tryClaimImageJob` helpers
- `src/sessions/wait-for-job.ts` — `waitForTtsReady` + `waitForImageReady` LISTEN-based helpers
- `tests/lib/job-claims.test.ts` — unit/DB tests for both claim helpers
- `tests/api/tts-coalesce.test.ts` — concurrent-call test for the TTS route
- `tests/api/scene-image-coalesce.test.ts` — concurrent-call test for the image route
- `tests/e2e/shared-jobs.spec.ts` — minimal E2E spec (gated on Clerk testing token)

**Modify:**
- `src/db/schema/tts-cache.ts` — add `status`, `startedAt`, `failedReason`; null bytes/mime allowed
- `src/db/schema/session-state.ts` — add `sceneImagePending`, `sceneImagePendingAt`, `sceneImageFailedReason`
- `src/sessions/notify.ts` — add 6 new event types
- `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts` — leader/follower flow
- `src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts` — leader/follower flow
- `src/sessions/use-session-stream.ts` — handle new events, track pending sets + transient errors
- `src/components/game/tts-button.tsx` — `sharedPending` / `sharedError` props
- `src/components/game/scene-image-button.tsx` — `sharedPending` / `sharedError` props
- `src/components/game/narrative-pane.tsx` — pass props through to buttons
- `src/app/(authed)/sessions/[id]/game-client.tsx` — wire new stream values to NarrativePane

---

## Phase 1 — Schema + migration

### Task 1: Add status columns to schema

**Files:**
- Modify: `src/db/schema/tts-cache.ts`
- Modify: `src/db/schema/session-state.ts`

- [ ] **Step 1: Update `tts-cache.ts`**

Replace the file body with:

```ts
import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { bytea } from '../types';
import { sessionMessages } from './session-messages';

/**
 * Server-side cache of synthesized TTS audio. Also acts as the single-flight
 * lock: when a synthesis is in-flight, the row exists with `status='pending'`
 * and `audio_mp3 IS NULL`. When complete, status flips to 'ready' and the
 * bytes are written. Followers (concurrent callers) see the pending row and
 * wait on `pg_notify('session_<id>')` for a `tts-ready` event.
 *
 * Keyed by (messageId, voice, model) — a single message can have multiple
 * cached audios if the user switches voice or model over time. On message
 * delete, cascade drops the cached entries.
 *
 * `started_at` is the lock acquisition timestamp; rows in `pending` older
 * than 60s are considered orphans and can be re-claimed by the next caller.
 */
export const ttsCache = pgTable(
  'tts_cache',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => sessionMessages.id, { onDelete: 'cascade' }),
    voice: text('voice').notNull(),
    model: text('model').notNull().default('gpt-4o-mini-tts'),
    /** NULL while status='pending' or 'failed'. */
    audioMp3: bytea('audio_mp3'),
    provider: text('provider').notNull().default('openai'),
    /** NULL while status='pending' or 'failed'. */
    mimeType: text('mime_type'),
    /** 'pending' | 'ready' | 'failed'. CHECK constraint enforces the domain. */
    status: text('status').notNull().default('ready'),
    /** Lock acquisition timestamp; used for TTL-based orphan re-claim. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Provider error message when status='failed'. */
    failedReason: text('failed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.voice, t.model] }),
  }),
);

export type TtsCacheRow = typeof ttsCache.$inferSelect;
export type TtsCacheInsert = typeof ttsCache.$inferInsert;
```

- [ ] **Step 2: Update `session-state.ts`**

In `src/db/schema/session-state.ts`, add three columns to the `sessionState` definition (after `sceneImageVersion`):

```ts
  sceneImageVersion: integer('scene_image_version').notNull().default(0),
  /** True while a scene-image generation job is in flight; UI renders a
   *  shared spinner across all clients. Set false on success/failure. */
  sceneImagePending: boolean('scene_image_pending').notNull().default(false),
  /** Lock timestamp for TTL-based orphan re-claim (60s). */
  sceneImagePendingAt: timestamp('scene_image_pending_at', { withTimezone: true }),
  /** Provider/error message when the last image attempt failed. NULL after
   *  success or while pending. */
  sceneImageFailedReason: text('scene_image_failed_reason'),
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/tts-cache.ts src/db/schema/session-state.ts
git commit -m "feat(schema): add pending/ready/failed job status to tts_cache + session_state"
```

---

### Task 2: Generate + customize migration

**Files:**
- Create: `drizzle/0032_<generated-name>.sql`
- Create: `drizzle/meta/0032_snapshot.json` (auto)
- Modify: `drizzle/meta/_journal.json` (auto)

- [ ] **Step 1: Generate**

```bash
pnpm db:generate
```
Expected: `drizzle/0032_*.sql` and `drizzle/meta/0032_snapshot.json` created. The SQL contains the ALTERs for both tables; `audio_mp3` and `mime_type` become nullable.

- [ ] **Step 2: Add CHECK constraint to the SQL**

Open the new `drizzle/0032_*.sql` file and append (after the existing ALTERs):

```sql
--> statement-breakpoint
ALTER TABLE "tts_cache" ADD CONSTRAINT "tts_cache_status_check"
  CHECK (status IN ('pending', 'ready', 'failed'));
```

This enforces the domain at the DB level. Existing rows default to `status='ready'` (from the column default) so the constraint passes immediately.

- [ ] **Step 3: Apply locally**

```bash
pnpm db:up
pnpm db:migrate
```
Expected: migration 0032 applied without errors.

- [ ] **Step 4: Spot-check**

```bash
docker compose exec postgres psql -U postgres -d dnd_master -c \
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns
   WHERE table_name='tts_cache' AND column_name IN ('status','started_at','failed_reason','audio_mp3','mime_type')
   ORDER BY column_name;"
```
Expected: `status` (text, NOT NULL), `started_at` (timestamp, NULL), `failed_reason` (text, NULL), `audio_mp3` (bytea, NULL), `mime_type` (text, NULL).

- [ ] **Step 5: Commit**

```bash
git add drizzle/0032_*.sql drizzle/meta/0032_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(db): migrate shared-jobs columns on tts_cache + session_state"
```

---

## Phase 2 — Notify payload + claim helpers

### Task 3: Extend `NotifyPayload`

**Files:**
- Modify: `src/sessions/notify.ts`

- [ ] **Step 1: Add the 6 new event types**

Replace the `NotifyPayload` type in `src/sessions/notify.ts` with:

```ts
export type NotifyPayload =
  | { type: 'message-chunk'; messageId: string; text: string }
  | { type: 'message'; messageId: string }
  | { type: 'state' }
  | { type: 'turn-change'; characterId: string }
  | { type: 'dice'; logId: string }
  | { type: 'turn-error'; reason: 'empty_response' | 'failed'; message?: string }
  // Single-flight job lifecycle events. Emitted by the leader that owns the
  // pending row; consumed by both follower request handlers (server-side) and
  // SSE clients (browser). `tts-pending` and `image-pending` carry the
  // messageId so the UI can render the shared spinner against the specific
  // master bubble; `tts-ready` likewise. `image-ready` doesn't carry a
  // messageId — the new scene_image_version is on session_state and a
  // /state refetch is enough.
  | { type: 'tts-pending'; messageId: string }
  | { type: 'tts-ready'; messageId: string }
  | { type: 'tts-failed'; messageId: string; reason: string }
  | { type: 'image-pending'; messageId: string }
  | { type: 'image-ready' }
  | { type: 'image-failed'; reason: string };
```

The rest of the file (the `notifySession` function) stays unchanged.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS. (Existing consumers of `NotifyPayload` only switch on `type`, so adding cases doesn't break exhaustive matches.)

- [ ] **Step 3: Commit**

```bash
git add src/sessions/notify.ts
git commit -m "feat(notify): add tts/image pending/ready/failed event types"
```

---

### Task 4: Implement `tryClaimTtsJob` + `tryClaimImageJob`

**Files:**
- Create: `src/sessions/job-claims.ts`
- Create: `tests/lib/job-claims.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/job-claims.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionMessages, sessionState, ttsCache } from '@/db/schema';
import { tryClaimTtsJob, tryClaimImageJob } from '@/sessions/job-claims';

const USER = 'user_job_claims_' + Date.now();
let campaignId: string;
let sessionId: string;
let messageId: string;

const VOICE = 'onyx';
const MODEL = 'gpt-4o-mini-tts';
const PROVIDER = 'openai';

describe('tryClaimTtsJob', () => {
  beforeAll(async () => {
    await db.insert(users).values({ id: USER, displayName: 'U' }).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({ userId: USER, name: 'JC', premise: 'p' }).returning();
    campaignId = c!.id;
    const [tpl] = await db.insert(characters).values({
      userId: USER, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    }).returning();
    const [inst] = await db.insert(characters).values({
      userId: USER, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId,
    }).returning();
    const [s] = await db.insert(sessions).values({
      userId: USER, characterId: inst!.id, campaignId, premise: 'p',
      currentPlayerCharacterId: inst!.id,
    }).returning();
    sessionId = s!.id;
    await db.insert(sessionState).values({ sessionId, hpCurrent: 12, hitDiceRemaining: 1 });
    const [m] = await db.insert(sessionMessages).values({
      sessionId, role: 'master', content: 'Once upon a time…',
    }).returning();
    messageId = m!.id;
  });

  beforeEach(async () => {
    await db.delete(ttsCache);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${USER}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER}`);
    await pool.end();
  });

  it('first caller becomes the leader (empty cache)', async () => {
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('leader');
    const [row] = await db.select().from(ttsCache).limit(1);
    expect(row?.status).toBe('pending');
    expect(row?.audioMp3).toBeNull();
  });

  it('second caller becomes follower while first is pending', async () => {
    await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    const res2 = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res2.result).toBe('follower');
  });

  it('returns ready when cache is hot', async () => {
    await db.insert(ttsCache).values({
      messageId, voice: VOICE, model: MODEL, provider: PROVIDER,
      status: 'ready', audioMp3: Buffer.from('audio-bytes'), mimeType: 'audio/mpeg',
    });
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('ready');
    expect(res.existing?.audioMp3?.toString()).toBe('audio-bytes');
  });

  it('re-claims a stale pending row (>60s old)', async () => {
    await db.insert(ttsCache).values({
      messageId, voice: VOICE, model: MODEL, provider: PROVIDER,
      status: 'pending', startedAt: new Date(Date.now() - 90_000),
    });
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('leader');
    const [row] = await db.select().from(ttsCache).limit(1);
    expect(row?.status).toBe('pending');
    expect(row!.startedAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('re-claims a failed row', async () => {
    await db.insert(ttsCache).values({
      messageId, voice: VOICE, model: MODEL, provider: PROVIDER,
      status: 'failed', failedReason: 'rate_limit',
      startedAt: new Date(Date.now() - 5_000),
    });
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('leader');
    const [row] = await db.select().from(ttsCache).limit(1);
    expect(row?.status).toBe('pending');
    expect(row?.failedReason).toBeNull();
  });
});

describe('tryClaimImageJob', () => {
  it('first caller becomes leader (pending=false initially)', async () => {
    await db.update(sessionState).set({ sceneImagePending: false, sceneImagePendingAt: null, sceneImageFailedReason: null }).where(sql`session_id = ${sessionId}`);
    const res = await tryClaimImageJob(sessionId);
    expect(res.isLeader).toBe(true);
    const [row] = await db.select().from(sessionState).where(sql`session_id = ${sessionId}`).limit(1);
    expect(row?.sceneImagePending).toBe(true);
  });

  it('second caller is a follower while pending', async () => {
    await tryClaimImageJob(sessionId);
    const res2 = await tryClaimImageJob(sessionId);
    expect(res2.isLeader).toBe(false);
  });

  it('re-claims a stale pending (>60s old)', async () => {
    await db.update(sessionState).set({
      sceneImagePending: true,
      sceneImagePendingAt: new Date(Date.now() - 90_000),
    }).where(sql`session_id = ${sessionId}`);
    const res = await tryClaimImageJob(sessionId);
    expect(res.isLeader).toBe(true);
  });

  it('re-claims when a previous attempt failed', async () => {
    await db.update(sessionState).set({
      sceneImagePending: false,
      sceneImagePendingAt: new Date(Date.now() - 5_000),
      sceneImageFailedReason: 'api_error',
    }).where(sql`session_id = ${sessionId}`);
    const res = await tryClaimImageJob(sessionId);
    expect(res.isLeader).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test tests/lib/job-claims.test.ts
```
Expected: FAIL with `tryClaimTtsJob is not exported` (module not found).

- [ ] **Step 3: Implement the helpers**

Create `src/sessions/job-claims.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ttsCache, sessionState, type TtsCacheRow } from '@/db/schema';

/** 60-second TTL on `pending` rows; older entries are treated as orphans
 *  and can be re-claimed. Long enough to outlast normal TTS/image latency,
 *  short enough that a crashed leader doesn't block the table for minutes. */
const JOB_TTL_MS = 60_000;

export type ClaimResult =
  | { result: 'leader' }
  | { result: 'follower'; existing: TtsCacheRow }
  | { result: 'ready'; existing: TtsCacheRow };

/**
 * Atomically try to become the leader of a TTS synthesis job for
 * (messageId, voice, model). Three outcomes:
 *
 * - `leader`: we hold the lock (a fresh `pending` row was inserted or a
 *   stale/failed row was re-claimed). Caller MUST call the provider, then
 *   UPDATE the row to `ready` (or `failed`) and emit the matching notify.
 * - `follower`: another concurrent caller is the leader. Caller MUST wait
 *   for `tts-ready`/`tts-failed` via the SSE channel (use `waitForTtsReady`).
 * - `ready`: bytes are already cached. Caller returns them directly.
 */
export async function tryClaimTtsJob(
  messageId: string,
  voice: string,
  model: string,
  provider: string,
): Promise<ClaimResult> {
  // 1. Optimistic INSERT. On conflict (the row already exists at this PK)
  //    we fall through to read its state.
  const inserted = await db
    .insert(ttsCache)
    .values({
      messageId, voice, model, provider,
      status: 'pending', startedAt: new Date(),
      audioMp3: null, mimeType: null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) return { result: 'leader' };

  // 2. Row exists. Read current state.
  const [row] = await db
    .select()
    .from(ttsCache)
    .where(and(
      eq(ttsCache.messageId, messageId),
      eq(ttsCache.voice, voice),
      eq(ttsCache.model, model),
    ))
    .limit(1);
  if (!row) {
    // Race: row was deleted between INSERT and SELECT. Retry once.
    return tryClaimTtsJob(messageId, voice, model, provider);
  }

  if (row.status === 'ready' && row.audioMp3) {
    return { result: 'ready', existing: row };
  }

  // 3. Pending older than TTL or previously failed → try to re-claim
  //    with an optimistic guard so two concurrent re-claimers don't both
  //    succeed.
  const isStale = row.startedAt && Date.now() - row.startedAt.getTime() > JOB_TTL_MS;
  if (isStale || row.status === 'failed') {
    const updated = await db
      .update(ttsCache)
      .set({
        status: 'pending', startedAt: new Date(),
        audioMp3: null, mimeType: null, failedReason: null,
        provider,
      })
      .where(and(
        eq(ttsCache.messageId, messageId),
        eq(ttsCache.voice, voice),
        eq(ttsCache.model, model),
        // Optimistic guard: row state must still match what we read.
        row.startedAt
          ? eq(ttsCache.startedAt, row.startedAt)
          : sql`started_at IS NULL`,
        eq(ttsCache.status, row.status),
      ))
      .returning();
    if (updated.length > 0) return { result: 'leader' };
    // someone else won the re-claim race; fall through as follower
  }

  return { result: 'follower', existing: row };
}

export type ImageClaimResult = { isLeader: boolean };

/**
 * Try to become the leader of a scene-image generation job for `sessionId`.
 *
 * A single conditional UPDATE either flips `scene_image_pending` to true
 * (we got the lock) or matches no rows (someone else holds it). Stale locks
 * (>60s) and previously failed attempts are treated as available.
 */
export async function tryClaimImageJob(sessionId: string): Promise<ImageClaimResult> {
  const ttlCutoff = new Date(Date.now() - JOB_TTL_MS);
  const updated = await db
    .update(sessionState)
    .set({
      sceneImagePending: true,
      sceneImagePendingAt: new Date(),
      sceneImageFailedReason: null,
    })
    .where(and(
      eq(sessionState.sessionId, sessionId),
      sql`(${sessionState.sceneImagePending} = false
            OR ${sessionState.sceneImagePendingAt} < ${ttlCutoff}
            OR ${sessionState.sceneImageFailedReason} IS NOT NULL)`,
    ))
    .returning({ sessionId: sessionState.sessionId });
  return { isLeader: updated.length > 0 };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test tests/lib/job-claims.test.ts
```
Expected: PASS, all 9 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/job-claims.ts tests/lib/job-claims.test.ts
git commit -m "feat(jobs): tryClaimTtsJob + tryClaimImageJob single-flight helpers"
```

---

### Task 5: Implement `waitForTtsReady` + `waitForImageReady`

**Files:**
- Create: `src/sessions/wait-for-job.ts`

This file isn't covered by a dedicated unit test (it's a thin LISTEN/poll wrapper that's much easier to exercise via the route-level coalesce tests in Tasks 6-7). Implement it now so the routes can import it.

- [ ] **Step 1: Create the helper module**

Create `src/sessions/wait-for-job.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db, createListenClient } from '@/db/client';
import { ttsCache, sessionState, type TtsCacheRow, type SessionState } from '@/db/schema';

const FOLLOWER_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

export type WaitResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' | 'failed'; detail?: string };

/**
 * Wait until the (messageId, voice, model) row reaches status='ready' or
 * 'failed', or until the timeout expires. Uses Postgres LISTEN on the
 * session channel plus a 2s poll fallback (the NOTIFY can arrive before
 * the LISTEN registers, especially on short jobs).
 */
export async function waitForTtsReady(
  sessionId: string,
  messageId: string,
  voice: string,
  model: string,
): Promise<WaitResult<TtsCacheRow>> {
  const channel = `session_${sessionId}`;
  const client = createListenClient();
  await client.connect();

  let settled = false;
  let resolveWait!: (r: WaitResult<TtsCacheRow>) => void;
  const waitPromise = new Promise<WaitResult<TtsCacheRow>>((res) => { resolveWait = res; });

  const readRow = async (): Promise<TtsCacheRow | null> => {
    const [row] = await db
      .select()
      .from(ttsCache)
      .where(and(
        eq(ttsCache.messageId, messageId),
        eq(ttsCache.voice, voice),
        eq(ttsCache.model, model),
      ))
      .limit(1);
    return row ?? null;
  };

  const trySettle = async (): Promise<void> => {
    if (settled) return;
    const row = await readRow();
    if (!row) return;
    if (row.status === 'ready' && row.audioMp3) {
      settled = true;
      resolveWait({ ok: true, value: row });
    } else if (row.status === 'failed') {
      settled = true;
      resolveWait({ ok: false, reason: 'failed', detail: row.failedReason ?? undefined });
    }
  };

  client.on('notification', (msg) => {
    if (!msg.payload) return;
    try {
      const ev = JSON.parse(msg.payload) as { type: string; messageId?: string };
      if (ev.messageId !== messageId) return;
      if (ev.type === 'tts-ready' || ev.type === 'tts-failed') {
        void trySettle();
      }
    } catch { /* ignore malformed payloads */ }
  });

  await client.query(`LISTEN "${channel}"`);
  // Immediate poll: covers the race where the leader's NOTIFY fired before
  // LISTEN was registered.
  await trySettle();

  const pollTimer = setInterval(() => { void trySettle(); }, POLL_INTERVAL_MS);
  const timeoutTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveWait({ ok: false, reason: 'timeout' });
  }, FOLLOWER_TIMEOUT_MS);

  try {
    return await waitPromise;
  } finally {
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    try { await client.query(`UNLISTEN "${channel}"`); } catch { /* ignore */ }
    try { await client.end(); } catch { /* ignore */ }
  }
}

/**
 * Wait until `session_state.scene_image_pending` flips back to false (job
 * concluded) and report whether it succeeded. The new version + bytes are
 * already persisted by the leader on success; the caller reads
 * `session_state` to surface them.
 */
export async function waitForImageReady(
  sessionId: string,
): Promise<WaitResult<SessionState>> {
  const channel = `session_${sessionId}`;
  const client = createListenClient();
  await client.connect();

  let settled = false;
  let resolveWait!: (r: WaitResult<SessionState>) => void;
  const waitPromise = new Promise<WaitResult<SessionState>>((res) => { resolveWait = res; });

  const readRow = async (): Promise<SessionState | null> => {
    const [row] = await db
      .select()
      .from(sessionState)
      .where(eq(sessionState.sessionId, sessionId))
      .limit(1);
    return row ?? null;
  };

  const trySettle = async (): Promise<void> => {
    if (settled) return;
    const row = await readRow();
    if (!row) return;
    if (row.sceneImagePending) return;
    if (row.sceneImageFailedReason) {
      settled = true;
      resolveWait({ ok: false, reason: 'failed', detail: row.sceneImageFailedReason });
    } else {
      settled = true;
      resolveWait({ ok: true, value: row });
    }
  };

  client.on('notification', (msg) => {
    if (!msg.payload) return;
    try {
      const ev = JSON.parse(msg.payload) as { type: string };
      if (ev.type === 'image-ready' || ev.type === 'image-failed') {
        void trySettle();
      }
    } catch { /* ignore */ }
  });

  await client.query(`LISTEN "${channel}"`);
  await trySettle();

  const pollTimer = setInterval(() => { void trySettle(); }, POLL_INTERVAL_MS);
  const timeoutTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveWait({ ok: false, reason: 'timeout' });
  }, FOLLOWER_TIMEOUT_MS);

  try {
    return await waitPromise;
  } finally {
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    try { await client.query(`UNLISTEN "${channel}"`); } catch { /* ignore */ }
    try { await client.end(); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/wait-for-job.ts
git commit -m "feat(jobs): waitForTtsReady + waitForImageReady follower wait helpers"
```

---

## Phase 3 — Route flows

### Task 6: TTS route — leader/follower flow

**Files:**
- Modify: `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts`
- Create: `tests/api/tts-coalesce.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/tts-coalesce.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionMessages, sessionState, ttsCache } from '@/db/schema';
import { NextRequest } from 'next/server';

const HOST = 'user_tts_coalesce_' + Date.now();
let CALLER = HOST;
let synthCalls = 0;

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: CALLER })),
}));

vi.mock('@/ai/tts', () => ({
  synthesizeSpeech: vi.fn(async () => {
    synthCalls += 1;
    // Slow enough that two concurrent calls both observe pending state.
    await new Promise((r) => setTimeout(r, 150));
    return { bytes: new TextEncoder().encode('FAKE_AUDIO').buffer, mimeType: 'audio/mpeg' };
  }),
}));

import { GET } from '@/app/api/sessions/[id]/messages/[messageId]/tts/route';

function getReq(): NextRequest {
  return new NextRequest('http://localhost/api/sessions/x/messages/y/tts', { method: 'GET' });
}

describe('GET /tts coalesces concurrent calls', () => {
  let sessionId: string;
  let messageId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: HOST, displayName: 'H' }).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'C', premise: 'p',
      // Force a specific voice/model so the route resolution is deterministic.
      settings: { ttsProvider: 'openai', ttsVoice: 'onyx', ttsModel: 'gpt-4o-mini-tts' },
    }).returning();
    const [tpl] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    }).returning();
    const [inst] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId: c!.id,
    }).returning();
    const [s] = await db.insert(sessions).values({
      userId: HOST, characterId: inst!.id, campaignId: c!.id, premise: 'p',
      currentPlayerCharacterId: inst!.id,
    }).returning();
    sessionId = s!.id;
    await db.insert(sessionState).values({ sessionId, hpCurrent: 12, hitDiceRemaining: 1 });
    const [m] = await db.insert(sessionMessages).values({
      sessionId, role: 'master', content: 'Once upon a time…',
    }).returning();
    messageId = m!.id;
  });

  beforeEach(async () => {
    await db.delete(ttsCache);
    synthCalls = 0;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${HOST}`);
    await pool.end();
  });

  it('only calls the provider once for two concurrent requests', async () => {
    const params = { params: Promise.resolve({ id: sessionId, messageId }) };
    const [r1, r2] = await Promise.all([GET(getReq(), params), GET(getReq(), params)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(synthCalls).toBe(1);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    const b2 = new Uint8Array(await r2.arrayBuffer());
    expect(new TextDecoder().decode(b1)).toBe('FAKE_AUDIO');
    expect(new TextDecoder().decode(b2)).toBe('FAKE_AUDIO');
  });

  it('a third request after completion hits the cache (no extra synth call)', async () => {
    const params = { params: Promise.resolve({ id: sessionId, messageId }) };
    await GET(getReq(), params);
    expect(synthCalls).toBe(1);
    await GET(getReq(), params);
    expect(synthCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/api/tts-coalesce.test.ts
```
Expected: FAIL — current route synthesizes twice (the test will show `synthCalls === 2`).

- [ ] **Step 3: Refactor the route**

Replace the body of `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, ttsCache } from '@/db/schema';
import { synthesizeSpeech } from '@/ai/tts';
import { getSessionMasterPreferences } from '@/lib/preferences';
import { checkPartyAccess } from '@/multiplayer/access';
import { tryClaimTtsJob } from '@/sessions/job-claims';
import { waitForTtsReady } from '@/sessions/wait-for-job';
import { notifySession } from '@/sessions/notify';

function audioResponse(bytes: ArrayBufferLike, mimeType: string, cacheHeader: string): Response {
  return new Response(bytes, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': String((bytes as ArrayBuffer).byteLength),
      'X-Tts-Cache': cacheHeader,
    },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId, messageId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const [message] = await db
    .select()
    .from(sessionMessages)
    .where(and(eq(sessionMessages.id, messageId), eq(sessionMessages.sessionId, sessionId)))
    .limit(1);
  if (!message) return NextResponse.json({ error: 'message-not-found' }, { status: 404 });
  if (message.role !== 'master') {
    return NextResponse.json({ error: 'tts-master-only' }, { status: 400 });
  }

  const prefs = await getSessionMasterPreferences(sessionId);
  const provider = prefs.ttsProvider;
  const voice = prefs.ttsVoice;
  const model = prefs.ttsModel;

  const claim = await tryClaimTtsJob(messageId, voice, model, provider);

  if (claim.result === 'ready') {
    const row = claim.existing;
    return audioResponse(new Uint8Array(row.audioMp3!).buffer, row.mimeType ?? 'audio/mpeg', 'HIT');
  }

  if (claim.result === 'leader') {
    await notifySession(sessionId, { type: 'tts-pending', messageId });
    try {
      const out = await synthesizeSpeech({ text: message.content, provider, voice, model });
      const buf = Buffer.from(out.bytes);
      await db.update(ttsCache)
        .set({ status: 'ready', audioMp3: buf, mimeType: out.mimeType })
        .where(and(
          eq(ttsCache.messageId, messageId),
          eq(ttsCache.voice, voice),
          eq(ttsCache.model, model),
        ));
      await notifySession(sessionId, { type: 'tts-ready', messageId });
      return audioResponse(out.bytes, out.mimeType, 'MISS');
    } catch (e) {
      const err = e as { status?: number; message?: string };
      const reason = err.message ?? 'tts-failed';
      console.error('tts.synth_failed', { provider, voice, model, messageId, status: err.status, message: reason });
      await db.update(ttsCache)
        .set({ status: 'failed', failedReason: reason })
        .where(and(
          eq(ttsCache.messageId, messageId),
          eq(ttsCache.voice, voice),
          eq(ttsCache.model, model),
        ));
      await notifySession(sessionId, { type: 'tts-failed', messageId, reason });
      const status = typeof err.status === 'number' && err.status === 429 ? 429 : 500;
      return NextResponse.json({ error: reason, upstreamStatus: err.status }, { status });
    }
  }

  // follower path: wait for the leader to complete
  const waited = await waitForTtsReady(sessionId, messageId, voice, model);
  if (!waited.ok) {
    if (waited.reason === 'failed') {
      return NextResponse.json({ error: waited.detail ?? 'tts-failed' }, { status: 500 });
    }
    return NextResponse.json({ error: 'tts-follower-timeout' }, { status: 504 });
  }
  const row = waited.value;
  return audioResponse(new Uint8Array(row.audioMp3!).buffer, row.mimeType ?? 'audio/mpeg', 'FOLLOWER');
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test tests/api/tts-coalesce.test.ts
```
Expected: PASS, both cases green and `synthCalls === 1` after concurrent calls.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts tests/api/tts-coalesce.test.ts
git commit -m "feat(tts): coalesce concurrent synth requests via leader/follower pattern"
```

---

### Task 7: scene-image route — leader/follower flow

**Files:**
- Modify: `src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts`
- Modify: `src/sessions/scene-image-job.ts`
- Create: `tests/api/scene-image-coalesce.test.ts`

The existing `generateAndPersist` clears the bytes + bumps the version on success but doesn't touch the new `scene_image_pending` flag. We add a post-success / post-failure update to the route so the flag flips back to false and the right notify event is emitted.

- [ ] **Step 1: Write the failing test**

Create `tests/api/scene-image-coalesce.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionMessages, sessionState } from '@/db/schema';
import { NextRequest } from 'next/server';

const HOST = 'user_img_coalesce_' + Date.now();
let CALLER = HOST;

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: CALLER })),
}));

let generateCalls = 0;
vi.mock('@/sessions/image-providers/openai', () => ({
  generateBytesOpenAI: vi.fn(async () => {
    generateCalls += 1;
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, bytes: Buffer.from('FAKE_PNG') };
  }),
  __setOpenAIClientForTest: () => {},
}));
vi.mock('@/sessions/image-providers/gemini', () => ({
  generateBytesGemini: vi.fn(),
  __setGeminiClientForTest: () => {},
}));

import { POST } from '@/app/api/sessions/[id]/messages/[messageId]/scene-image/route';

function postReq(): NextRequest {
  return new NextRequest('http://localhost/api/sessions/x/messages/y/scene-image', { method: 'POST' });
}

describe('POST /scene-image coalesces concurrent calls', () => {
  let sessionId: string;
  let messageId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: HOST, displayName: 'H' }).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'C', premise: 'p',
      settings: { imageGenerationEnabled: true, imageProvider: 'openai', imageStylePreset: 'pastel' },
    }).returning();
    const [tpl] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    }).returning();
    const [inst] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId: c!.id,
    }).returning();
    const [s] = await db.insert(sessions).values({
      userId: HOST, characterId: inst!.id, campaignId: c!.id, premise: 'p',
      currentPlayerCharacterId: inst!.id,
    }).returning();
    sessionId = s!.id;
    await db.insert(sessionState).values({ sessionId, hpCurrent: 12, hitDiceRemaining: 1 });
    const [m] = await db.insert(sessionMessages).values({
      sessionId, role: 'master', content: 'A torchlit hall stretches ahead.',
    }).returning();
    messageId = m!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${HOST}`);
    await pool.end();
  });

  it('only calls the image provider once for two concurrent requests', async () => {
    const params = { params: Promise.resolve({ id: sessionId, messageId }) };
    const [r1, r2] = await Promise.all([POST(postReq(), params), POST(postReq(), params)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(generateCalls).toBe(1);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.version).toBe(1);
    expect(j2.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/api/scene-image-coalesce.test.ts
```
Expected: FAIL — current route doesn't claim the lock, so both callers go through, and one gets 409 race_lost while the other gets 200.

- [ ] **Step 3: Refactor the route**

Replace the body of `src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, sessionState, characters } from '@/db/schema';
import { getSessionMasterPreferences } from '@/lib/preferences';
import { resolveStyleText, buildCharacterAppearance } from '@/ai/master/image-style';
import { generateAndPersist } from '@/sessions/scene-image-job';
import { checkPartyAccess } from '@/multiplayer/access';
import { tryClaimImageJob } from '@/sessions/job-claims';
import { waitForImageReady } from '@/sessions/wait-for-job';
import { notifySession } from '@/sessions/notify';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId, messageId } = await params;

  const [row] = await db
    .select({
      messageRole: sessionMessages.role,
      messageContent: sessionMessages.content,
      currentVersion: sessionState.sceneImageVersion,
      charName: characters.name,
      charRaceSlug: characters.raceSlug,
      charClassSlug: characters.classSlug,
      charIdentity: characters.identity,
    })
    .from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .innerJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .innerJoin(characters, eq(characters.id, sessions.characterId))
    .where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.deletedAt),
      eq(sessionMessages.id, messageId),
    ))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (row.messageRole !== 'master') {
    return NextResponse.json({ error: 'not-a-master-message' }, { status: 400 });
  }
  if (!row.messageContent.trim()) {
    return NextResponse.json({ error: 'empty-message' }, { status: 400 });
  }

  const prefs = await getSessionMasterPreferences(sessionId);
  if (!prefs.imageGenerationEnabled) {
    return NextResponse.json({ error: 'image-generation-disabled' }, { status: 403 });
  }

  const claim = await tryClaimImageJob(sessionId);
  if (!claim.isLeader) {
    // Follower path: leader already emitted image-pending; just wait.
    const waited = await waitForImageReady(sessionId);
    if (!waited.ok) {
      if (waited.reason === 'failed') {
        return NextResponse.json({ error: waited.detail ?? 'image-failed' }, { status: 502 });
      }
      return NextResponse.json({ error: 'image-follower-timeout' }, { status: 504 });
    }
    return NextResponse.json({ version: waited.value.sceneImageVersion });
  }

  // Leader path
  await notifySession(sessionId, { type: 'image-pending', messageId });

  const styleText = resolveStyleText(prefs);
  const characterAppearance = buildCharacterAppearance({
    name: row.charName,
    raceSlug: row.charRaceSlug,
    classSlug: row.charClassSlug,
    identity: row.charIdentity,
  });
  const nextVersion = row.currentVersion + 1;

  try {
    const result = await generateAndPersist(
      sessionId,
      row.messageContent,
      styleText,
      nextVersion,
      prefs.imageProvider,
      prefs.imageModel,
      characterAppearance,
    );

    if (!result.ok) {
      await db.update(sessionState)
        .set({ sceneImagePending: false, sceneImageFailedReason: result.reason })
        .where(eq(sessionState.sessionId, sessionId));
      await notifySession(sessionId, { type: 'image-failed', reason: result.reason });
      return NextResponse.json(
        { error: result.reason, detail: 'detail' in result ? result.detail : undefined },
        { status: result.reason === 'race_lost' ? 409 : 502 },
      );
    }

    await db.update(sessionState)
      .set({ sceneImagePending: false, sceneImageFailedReason: null })
      .where(eq(sessionState.sessionId, sessionId));
    await notifySession(sessionId, { type: 'image-ready' });
    return NextResponse.json({ version: result.version });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'image-failed';
    await db.update(sessionState)
      .set({ sceneImagePending: false, sceneImageFailedReason: reason })
      .where(eq(sessionState.sessionId, sessionId));
    await notifySession(sessionId, { type: 'image-failed', reason });
    throw e;
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test tests/api/scene-image-coalesce.test.ts
```
Expected: PASS, `generateCalls === 1`.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts' tests/api/scene-image-coalesce.test.ts
git commit -m "feat(scene-image): coalesce concurrent generation requests"
```

---

## Phase 4 — Client wiring

### Task 8: Extend `useSessionStream` with pending sets + transient errors

**Files:**
- Modify: `src/sessions/use-session-stream.ts`

- [ ] **Step 1: Augment the hook**

Open `src/sessions/use-session-stream.ts`. Right after the `finalizedSeq` declaration (around line 34), add:

```ts
  const [ttsPending, setTtsPending] = React.useState<Set<string>>(new Set());
  const [ttsErrors, setTtsErrors] = React.useState<Map<string, string>>(new Map());
  const [imagePending, setImagePending] = React.useState(false);
  const [imageError, setImageError] = React.useState<string | null>(null);
```

Make sure `React` is imported (or replace `React.useState` with the already-imported `useState`).

Inside the SSE switch (in `es.onmessage`), add the new cases after the existing ones:

```ts
          case 'tts-pending':
            setTtsPending((prev) => {
              if (prev.has(ev.messageId)) return prev;
              const next = new Set(prev);
              next.add(ev.messageId);
              return next;
            });
            setTtsErrors((prev) => {
              if (!prev.has(ev.messageId)) return prev;
              const next = new Map(prev);
              next.delete(ev.messageId);
              return next;
            });
            break;
          case 'tts-ready':
            setTtsPending((prev) => {
              if (!prev.has(ev.messageId)) return prev;
              const next = new Set(prev);
              next.delete(ev.messageId);
              return next;
            });
            break;
          case 'tts-failed':
            setTtsPending((prev) => {
              if (!prev.has(ev.messageId)) return prev;
              const next = new Set(prev);
              next.delete(ev.messageId);
              return next;
            });
            setTtsErrors((prev) => new Map(prev).set(ev.messageId, ev.reason ?? 'failed'));
            setTimeout(() => {
              setTtsErrors((prev) => {
                if (!prev.has(ev.messageId)) return prev;
                const next = new Map(prev);
                next.delete(ev.messageId);
                return next;
              });
            }, 5_000);
            break;
          case 'image-pending':
            setImagePending(true);
            setImageError(null);
            break;
          case 'image-ready':
            setImagePending(false);
            void refetch();
            break;
          case 'image-failed':
            setImagePending(false);
            setImageError(ev.reason ?? 'failed');
            setTimeout(() => setImageError(null), 5_000);
            break;
```

Finally, add the new values to the return object at the bottom of the hook. Find the existing `return { ... }` line and add:

```ts
  return {
    snapshot,
    streamingMessage,
    error,
    turnError,
    finalizedSeq,
    refetch,
    clearTurnError,
    clearStreamingMessage,
    ttsPending,
    ttsErrors,
    imagePending,
    imageError,
  };
```

(Preserve the existing keys; just add `ttsPending`, `ttsErrors`, `imagePending`, `imageError`.)

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/use-session-stream.ts
git commit -m "feat(stream): expose ttsPending/imagePending sets + transient errors"
```

---

### Task 9: Extend `TtsButton` with shared pending/error props

**Files:**
- Modify: `src/components/game/tts-button.tsx`

- [ ] **Step 1: Add new props + render logic**

In `src/components/game/tts-button.tsx`, change the props interface and the state derivation:

```tsx
export interface TtsButtonProps {
  sessionId: string;
  messageId: string;
  /** True when ANY client in the session has an in-flight TTS job for this
   *  message. The button shows a shared spinner regardless of who clicked. */
  sharedPending?: boolean;
  /** When non-null, render the transient "Failed" state. Parent clears this
   *  after ~5s on its own. */
  sharedError?: string | null;
}

export function TtsButton({ sessionId, messageId, sharedPending = false, sharedError = null }: TtsButtonProps) {
```

Then change the derived `state` rendering: find the existing
`const label = state === 'playing' ? 'Pause' : state === 'loading' ? 'Generando…' : state === 'error' ? 'Retry' : 'Listen';`
and replace the whole label/render block (lines ~148 to the end of the JSX) with this:

```tsx
  const effectiveState: State =
    sharedError ? 'error' : sharedPending && state !== 'playing' ? 'loading' : state;
  const effectiveError = sharedError ?? error;

  const label =
    effectiveState === 'playing' ? 'Pause'
      : effectiveState === 'loading' ? 'Generando…'
      : effectiveState === 'error' ? 'Failed'
      : 'Listen';

  return (
    <button
      onClick={onClick}
      disabled={sharedPending && state !== 'playing'}
      title={effectiveError ?? label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        background: effectiveState === 'error' ? 'rgba(196, 95, 71, 0.10)' : 'transparent',
        border: '1px solid ' + (effectiveState === 'error' ? 'var(--ember)' : 'var(--border)'),
        borderRadius: 999,
        color: effectiveState === 'error' ? 'var(--ember)' : 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        cursor: effectiveState === 'loading' ? 'wait' : 'pointer',
      }}
    >
      {effectiveState === 'loading' ? (
        <SpinningDie size={11} />
      ) : effectiveState === 'playing' ? (
        <Icon name="pause" size={11} />
      ) : (
        <Icon name="volume" size={11} />
      )}
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/game/tts-button.tsx
git commit -m "feat(tts-button): accept sharedPending + sharedError props"
```

---

### Task 10: Extend `SceneImageButton` with shared pending/error props

**Files:**
- Modify: `src/components/game/scene-image-button.tsx`

- [ ] **Step 1: Add props + render logic**

In `src/components/game/scene-image-button.tsx`:

Change the props interface:

```tsx
export interface SceneImageButtonProps {
  sessionId: string;
  messageId: string;
  /** True when any client in the session has an image-generation job in
   *  flight. Renders a shared spinner regardless of who triggered it. */
  sharedPending?: boolean;
  /** Transient broadcast error from any client's failed generation.
   *  Auto-clears upstream after ~5s. */
  sharedError?: string | null;
}

export function SceneImageButton({ sessionId, messageId, sharedPending = false, sharedError = null }: SceneImageButtonProps) {
```

Then update the derived state and the render block. Replace the existing `label = …` and the JSX (lines ~46-93) with:

```tsx
  const effectiveState: State =
    sharedError ? 'error' : sharedPending ? 'loading' : state;
  const effectiveError = sharedError ?? error;

  const label =
    effectiveState === 'loading' ? 'Generating…'
      : effectiveState === 'done' ? 'Generated'
      : effectiveState === 'error' ? 'Failed'
      : 'Image';

  return (
    <button
      onClick={onClick}
      disabled={sharedPending}
      title={effectiveError ?? label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        background:
          effectiveState === 'error'
            ? 'rgba(196, 95, 71, 0.10)'
            : effectiveState === 'done'
              ? 'rgba(122, 79, 184, 0.10)'
              : 'transparent',
        border:
          '1px solid ' +
          (effectiveState === 'error' ? 'var(--ember)' : effectiveState === 'done' ? 'var(--arcane)' : 'var(--border)'),
        borderRadius: 999,
        color:
          effectiveState === 'error' ? 'var(--ember)' : effectiveState === 'done' ? 'var(--arcane)' : 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        cursor: effectiveState === 'loading' ? 'wait' : 'pointer',
      }}
    >
      {effectiveState === 'loading' ? (
        <SpinningDie size={11} />
      ) : effectiveState === 'done' ? (
        <Icon name="check" size={11} />
      ) : (
        <Icon name="sparkle" size={11} />
      )}
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/game/scene-image-button.tsx
git commit -m "feat(scene-image-button): accept sharedPending + sharedError props"
```

---

### Task 11: Wire shared state through NarrativePane + game-client

**Files:**
- Modify: `src/components/game/narrative-pane.tsx`
- Modify: `src/app/(authed)/sessions/[id]/game-client.tsx`

- [ ] **Step 1: Plumb new props through `NarrativePane`**

In `src/components/game/narrative-pane.tsx`:

1. Extend `NarrativePaneProps` with four new optional fields:

```ts
export interface NarrativePaneProps {
  // …existing fields
  ttsPending?: Set<string>;
  ttsErrors?: Map<string, string>;
  imagePending?: boolean;
  imageError?: string | null;
}
```

2. Destructure them in the `NarrativePane` function signature, with defaults:

```ts
export function NarrativePane({
  sessionId, history, liveEvents, busy, onSend, onCastSpell,
  manualRolls, imageGenerationEnabled = false,
  disabled = false, disabledPlaceholder, party = [], compact = false,
  ttsPending,
  ttsErrors,
  imagePending = false,
  imageError = null,
}: NarrativePaneProps) {
```

3. Find the inner component that renders each master message (it iterates over `history` and renders TtsButton/SceneImageButton). Pass the new props down. Look for the existing JSX block like:

```tsx
            {m.id && <TtsButton sessionId={sessionId} messageId={m.id} />}
            {m.id && imageGenerationEnabled && (
              <SceneImageButton sessionId={sessionId} messageId={m.id} />
            )}
```

Replace with:

```tsx
            {m.id && (
              <TtsButton
                sessionId={sessionId}
                messageId={m.id}
                sharedPending={ttsPending?.has(m.id) ?? false}
                sharedError={ttsErrors?.get(m.id) ?? null}
              />
            )}
            {m.id && imageGenerationEnabled && (
              <SceneImageButton
                sessionId={sessionId}
                messageId={m.id}
                sharedPending={imagePending}
                sharedError={imageError}
              />
            )}
```

If `NarrativePane` already forwards props to an inner row component, plumb them through that component's props instead (mirroring how `manualRolls` and `imageGenerationEnabled` flow today).

- [ ] **Step 2: Read the new values from the stream in game-client**

In `src/app/(authed)/sessions/[id]/game-client.tsx`:

Find the existing `useSessionStream(sessionId)` destructure and add the new fields:

```ts
  const {
    snapshot,
    streamingMessage,
    // …existing
    ttsPending,
    ttsErrors,
    imagePending,
    imageError,
  } = useSessionStream(sessionId);
```

Then find each `<NarrativePane …/>` usage (there are typically two: mobile and desktop) and add the four props:

```tsx
<NarrativePane
  // …existing props
  ttsPending={ttsPending}
  ttsErrors={ttsErrors}
  imagePending={imagePending}
  imageError={imageError}
/>
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add 'src/components/game/narrative-pane.tsx' 'src/app/(authed)/sessions/[id]/game-client.tsx'
git commit -m "feat(game): plumb shared TTS/image pending state through to buttons"
```

---

## Phase 5 — E2E + final sweep

### Task 12: Minimal E2E spec

**Files:**
- Create: `tests/e2e/shared-jobs.spec.ts`

Mirroring the existing E2E pattern (gated on `CLERK_TESTING_TOKEN_USER_ID`). The full multi-context flow is non-trivial to seed; we ship a smoke that the buttons render and the wiring loads without hitting runtime errors.

- [ ] **Step 1: Create the spec**

Create `tests/e2e/shared-jobs.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

test('unauthed /sessions still redirects to sign-in (smoke)', async ({ page }) => {
  await page.goto('/sessions/00000000-0000-0000-0000-000000000000');
  await page.waitForURL(/\/(sign-in|campaigns)/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/(sign-in|campaigns)/);
});

test('authenticated game-client renders Listen button on master messages', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  // Get into a session: create campaign + character via the existing wizard.
  await page.goto('/campaigns/new');
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();
  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);

  // Master's initial narration should arrive within a few seconds.
  await expect(page.getByRole('button', { name: /listen/i }).first()).toBeVisible({ timeout: 30_000 });
});
```

- [ ] **Step 2: Run the spec**

```bash
pnpm test:e2e tests/e2e/shared-jobs.spec.ts
```
Expected: 1 passed (unauthed smoke). The second test is skipped without `CLERK_TESTING_TOKEN_USER_ID`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/shared-jobs.spec.ts
git commit -m "test(e2e): smoke spec for shared-jobs UI wiring"
```

---

### Task 13: Final sweep

- [ ] **Step 1: Run typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck clean. Lint failures only in files this branch didn't touch are acceptable (pre-existing). Tests: 3 pre-existing failures from `tests/sessions/applicator.test.ts` and `tests/ai/master/live-smoke.test.ts` are still expected; everything in this branch's new tests should pass.

- [ ] **Step 2: Spot-check the game flow locally**

```bash
pnpm dev
```

Log in, open an active session in two tabs (same campaign):

- Tab A: click "Listen" on a master message → both tabs should display the spinner condiviso while the synthesis runs (~3-5s).
- Tab A: when audio plays, tab B's button returns to "Listen" (cache HIT). Click in tab B → instant playback.
- Tab A: click "Image" (with image generation enabled in campaign settings) → both tabs show "Generating…" → on success the Scene panel updates in both tabs.

Stop the dev server.

- [ ] **Step 3: Final commit if anything trailing**

```bash
git status
```

If clean, no commit needed. Otherwise commit any cleanup:

```bash
git add -A
git commit -m "chore: cleanup after shared-jobs rollout"
```

---

## Done

The shared TTS + scene-image jobs feature is complete:

- One call to the TTS provider per `(message, voice, model)` across the campaign session — followers piggy-back via Postgres LISTEN + 2s poll fallback.
- One call to the image provider per `(session, version)` — same pattern.
- Every connected client renders a shared spinner while a job is in flight, sees the result simultaneously, and gets a 5s transient error on failure followed by an auto-reset to the clickable state.
- Failure handling is symmetric on both endpoints: leader marks the row failed, emits the matching notify, follower returns the same error response.
