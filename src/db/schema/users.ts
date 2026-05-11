import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export interface UserPreferences {
  /** OpenAI TTS voice slug. Defaults to env / 'onyx' if unset. */
  ttsVoice?: string;
  /** OpenAI TTS model slug ('gpt-4o-mini-tts' | 'tts-1' | 'tts-1-hd'). Defaults to
   *  env OPENAI_TTS_MODEL / 'gpt-4o-mini-tts' if unset. */
  ttsModel?: string;
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
  aiProvider?: 'anthropic' | 'openai' | 'gemini';
  /** Specific model used for master narration + wizard proposals. When unset, falls back to env defaults. */
  aiMasterModel?: string;
  /**
   * Controls how proactively the master suggests possible actions to the player.
   * - 'free': narrate the scene and end with an open question. No bullet lists,
   *   no enumerated options. Player drives every choice.
   * - 'balanced': may hint at possibilities in flowing prose ("vedi due varchi
   *   davanti a te, una porta e un'arco di pietra") but does not enumerate
   *   options as a list.
   * - 'structured': full "Vuoi:" / "Choose:" lists with numbered/bulleted
   *   options and explicit roll requests per option. Default for new users.
   */
  masterGuidanceLevel?: 'free' | 'balanced' | 'structured';
  /**
   * When true (default), the master reveals difficulty numbers in prose:
   * "tira una prova di Intuito CD 12" / "Roll 1d20+5 to attack (AC 13)".
   * When false, those numbers are kept hidden — the master uses qualitative
   * language ("a tough Insight check") and adjudicates privately when the
   * player's number comes back. More immersive: the player rolls without
   * knowing exactly how hard the check is.
   */
  showDifficultyNumbers?: boolean;
  /** When true, the master may call generate_scene_image to illustrate the scene. Default false. */
  imageGenerationEnabled?: boolean;
  /** Style preset slug. Default 'pastel'. 'custom' uses imageStyleCustom. */
  imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
  /** Free-text style description, used only when imageStylePreset === 'custom'. */
  imageStyleCustom?: string;
  /** Provider for scene illustration. When unset, falls back to IMAGE_PROVIDER env (default 'openai'). */
  imageProvider?: 'openai' | 'gemini';
  /** Specific image model slug. When unset, falls back to provider env default. */
  imageModel?: string;
}

export type MasterGuidanceLevel = NonNullable<UserPreferences['masterGuidanceLevel']>;
export const MASTER_GUIDANCE_LEVELS: MasterGuidanceLevel[] = ['free', 'balanced', 'structured'];
export function isMasterGuidanceLevel(v: unknown): v is MasterGuidanceLevel {
  return typeof v === 'string' && (MASTER_GUIDANCE_LEVELS as string[]).includes(v);
}

export type ImageStylePreset = NonNullable<UserPreferences['imageStylePreset']>;
export const IMAGE_STYLE_PRESETS: ImageStylePreset[] = ['pastel', 'watercolor', 'oil', 'ink', 'photo', 'custom'];
export function isImageStylePreset(v: unknown): v is ImageStylePreset {
  return typeof v === 'string' && (IMAGE_STYLE_PRESETS as string[]).includes(v);
}

export const users = pgTable('users', {
  id: text('id').primaryKey(),                  // Clerk subject (user_xxx)
  displayName: text('display_name'),
  preferences: jsonb('preferences').notNull().default(sql`'{}'::jsonb`).$type<UserPreferences>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
