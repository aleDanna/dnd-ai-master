import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { bytea } from '../types';
import { sessionMessages } from './session-messages';

/**
 * Server-side cache of synthesized TTS audio. Keyed by (messageId, voice, model)
 * — a single message can have multiple cached audios if the user switches voice
 * or model over time. On message delete, cascade drops the cached entries.
 */
export const ttsCache = pgTable(
  'tts_cache',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => sessionMessages.id, { onDelete: 'cascade' }),
    voice: text('voice').notNull(),
    model: text('model').notNull().default('gpt-4o-mini-tts'),
    audioMp3: bytea('audio_mp3').notNull(),
    /**
     * Provider that synthesized this audio. Implicit constraint: voice + model
     * are namespaced per provider (OpenAI's "onyx" / "gpt-4o-mini-tts" can never
     * collide with Gemini's "Kore" / "gemini-2.5-flash-preview-tts"), so this
     * column is metadata for debugging; PK uniqueness comes from voice + model.
     */
    provider: text('provider').notNull().default('openai'),
    /**
     * MIME type of the bytes in `audio_mp3`. OpenAI returns audio/mpeg (MP3);
     * Gemini returns 24kHz PCM that we wrap in a WAV container before storing,
     * so those rows have audio/wav. The TTS route forwards this as Content-Type.
     */
    mimeType: text('mime_type').notNull().default('audio/mpeg'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.voice, t.model] }),
  }),
);

export type TtsCacheRow = typeof ttsCache.$inferSelect;
export type TtsCacheInsert = typeof ttsCache.$inferInsert;
