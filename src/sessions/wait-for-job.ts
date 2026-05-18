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
