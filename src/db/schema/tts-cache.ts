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
