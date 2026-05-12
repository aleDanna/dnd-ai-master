// src/sessions/notify.ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export type NotifyPayload =
  | { type: 'message-chunk'; messageId: string; text: string }
  | { type: 'message'; messageId: string }
  | { type: 'state' }
  | { type: 'turn-change'; characterId: string }
  | { type: 'dice'; logId: string };

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
