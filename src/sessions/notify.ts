// src/sessions/notify.ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export type NotifyPayload =
  | { type: 'message-chunk'; messageId: string; text: string }
  | { type: 'message'; messageId: string }
  | { type: 'state' }
  | { type: 'turn-change'; characterId: string }
  | { type: 'dice'; logId: string }
  // Master loop completed without persisting a master message (empty finalText,
  // typically Gemini-style "tool calls only / end_turn"). The current player
  // stays the current player so they can retry. The client shows an inline
  // error so the user knows the turn fizzled instead of hanging silently.
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

/**
 * Emit a Postgres NOTIFY on channel `session_<id>`. All SSE subscribers
 * for this session receive the payload via LISTEN. Payload size is capped
 * by Postgres at 8000 bytes; we defensively drop if over 7900.
 */
export async function notifySession(sessionId: string, payload: NotifyPayload): Promise<void> {
  const json = JSON.stringify(payload);
  if (json.length > 7900) {
    console.warn('notifySession: payload too large, dropping', { sessionId, type: payload.type, size: json.length });
    return;
  }
  const channel = `session_${sessionId}`;
  await db.execute(sql`SELECT pg_notify(${channel}, ${json})`);
}
