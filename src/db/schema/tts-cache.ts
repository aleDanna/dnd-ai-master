import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { bytea } from '../types';
import { sessionMessages } from './session-messages';

/**
 * Server-side cache of synthesized TTS audio. Keyed by (messageId, voice) — a single
 * message can have multiple cached audios if the user switches voice over time.
 * On message delete, cascade drops the cached entries.
 */
export const ttsCache = pgTable(
  'tts_cache',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => sessionMessages.id, { onDelete: 'cascade' }),
    voice: text('voice').notNull(),
    audioMp3: bytea('audio_mp3').notNull(),
    provider: text('provider').notNull().default('openai'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.voice] }),
  }),
);

export type TtsCacheRow = typeof ttsCache.$inferSelect;
export type TtsCacheInsert = typeof ttsCache.$inferInsert;
