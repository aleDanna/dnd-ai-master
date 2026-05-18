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
