import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export interface UserPreferences {
  /** OpenAI TTS voice slug. Defaults to env / 'onyx' if unset. */
  ttsVoice?: string;
  /** When true, the master's response is auto-played after each turn. Default false. */
  ttsAutoplay?: boolean;
  /**
   * When true, the master writes roll formulas in the narrative and the app renders
   * an in-app roll button per formula. The player taps it, the app rolls + animates,
   * and the result auto-sends as the next player turn. State-change tools still run
   * server-side. Default false (auto-rolls server-side, current behaviour).
   */
  manualRolls?: boolean;
  /** Provider for the AI master. When unset, falls back to MASTER_PROVIDER env. */
  aiProvider?: 'anthropic' | 'openai';
  /** Specific model used for master narration + wizard proposals. When unset, falls back to env defaults. */
  aiMasterModel?: string;
}

export const users = pgTable('users', {
  id: text('id').primaryKey(),                  // Clerk subject (user_xxx)
  displayName: text('display_name'),
  preferences: jsonb('preferences').notNull().default(sql`'{}'::jsonb`).$type<UserPreferences>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
