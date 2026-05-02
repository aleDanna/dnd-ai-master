import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export interface UserPreferences {
  /** OpenAI TTS voice slug. Defaults to env / 'onyx' if unset. */
  ttsVoice?: string;
  /** When true, the master's response is auto-played after each turn. Default false. */
  ttsAutoplay?: boolean;
}

export const users = pgTable('users', {
  id: text('id').primaryKey(),                  // Clerk subject (user_xxx)
  displayName: text('display_name'),
  preferences: jsonb('preferences').notNull().default(sql`'{}'::jsonb`).$type<UserPreferences>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
