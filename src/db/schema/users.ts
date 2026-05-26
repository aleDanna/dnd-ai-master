import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import type { ProviderName, ImageProviderName } from '@/lib/ai-models';
import type { MasterBackend } from './campaigns';

export interface UserPreferences {
  /** TTS provider. 'openai', 'gemini', or 'local' (Piper via env-gated
   *  self-hosted services). Anthropic has no TTS endpoint, so this list is
   *  independent of `aiProvider`. Defaults to env TTS_PROVIDER / 'openai'
   *  if unset. 'local' is downgraded silently if env / isLocalEnvironment is off. */
  ttsProvider?: 'openai' | 'gemini' | 'local';
  /** TTS voice slug. Namespace depends on `ttsProvider` — OpenAI uses
   *  alloy/onyx/…, Gemini uses Aoede/Kore/…. Defaults per-provider. */
  ttsVoice?: string;
  /** TTS model slug. OpenAI: gpt-4o-mini-tts / tts-1 / tts-1-hd.
   *  Gemini: gemini-2.5-flash-preview-tts / gemini-2.5-pro-preview-tts.
   *  Defaults per-provider. */
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
  aiProvider?: ProviderName;
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
  /**
   * Narration pace.
   * - 'detailed' (default): every micro-beat is its own master turn — notice
   *   the lever, press the lever, the door opens, what do you do — preserving
   *   the current granular pacing.
   * - 'brisk': the master collapses obvious follow-through into the same beat.
   *   Spotting a secret passage and the player saying "I press it" resolves
   *   into a single beat that shows the open passage AND the player crossing
   *   it (unless an in-fiction reason warrants a pause: a hidden hazard, a
   *   choice point, a check). Cuts down on the "you're inside; now what?"
   *   filler turns. Combat rounds, declared checks, and meaningful choices
   *   are NOT collapsed — only obvious low-stakes filler.
   */
  narrationPace?: 'detailed' | 'brisk';
  /** When true, the master may call generate_scene_image to illustrate the scene. Default false. */
  imageGenerationEnabled?: boolean;
  /** Style preset slug. Default 'pastel'. 'custom' uses imageStyleCustom. */
  imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
  /** Free-text style description, used only when imageStylePreset === 'custom'. */
  imageStyleCustom?: string;
  /** Provider for scene illustration. When unset, falls back to IMAGE_PROVIDER env (default 'openai'). */
  imageProvider?: ImageProviderName;
  /** Specific image model slug. When unset, falls back to provider env default. */
  imageModel?: string;
  /**
   * When true, the master system prompt uses compact variants of the SRD
   * + handbook + world lore (Plan C). Trades narrative depth for raw
   * latency on small local models. When undefined, defaults to true for
   * `aiProvider === 'local'` and false for cloud providers.
   */
  compactPrompt?: boolean;
  /**
   * When true, the system prompt is selected based on the active AI mode
   * (local vs cloud). Enables mode-aware prompt switching so local models
   * receive a trimmed prompt while cloud models keep the full version.
   * When undefined, defaults to true for `aiProvider === 'local'` and
   * false for cloud providers.
   */
  useModeAwarePrompt?: boolean;
  /**
   * When true, the AI master retrieves relevant lore/world context via RAG
   * before generating each response (Plan E.2). Default false in Phase 2
   * (opt-in); Phase 3 flips the default to true for local providers.
   */
  useRagRetrieval?: boolean;
  /**
   * Phase 01 vault-llm-wiki migration — parallel-shape with `CampaignSettings.masterBackend`.
   * This field exists on UserPreferences for type compatibility with
   * `getSessionMasterPreferences` (which returns `Required<UserPreferences>`)
   * — resolution is campaign-only by design (Decision 2 in PLAN.md).
   * Never read directly by code; the campaign field is authoritative.
   */
  masterBackend?: MasterBackend;
  /**
   * Phase 02 vault-llm-wiki — parallel-shape with `CampaignSettings.vaultMutations`.
   * Mirrors the masterBackend pattern: this field exists on UserPreferences
   * purely for type compatibility with `getSessionMasterPreferences` /
   * `getResolvedPreferences` (both return `Required<UserPreferences>`) —
   * resolution is campaign-only by design (Decision 5 in 02-RESEARCH.md).
   * Never read directly by code; the campaign field is authoritative.
   */
  vaultMutations?: boolean;
  /**
   * Phase 03-B vault-llm-wiki — parallel-shape with `CampaignSettings.sourceOfTruth`.
   * Mirrors the masterBackend / vaultMutations pattern: this field exists on
   * UserPreferences purely for type compatibility with
   * `getSessionMasterPreferences` / `getResolvedPreferences` (both return
   * `Required<UserPreferences>`) — resolution is campaign-only by design
   * (Decision 4 in 03-RESEARCH.md). Never read directly by code; the
   * campaign field is authoritative.
   */
  sourceOfTruth?: 'postgres' | 'vault';
  /**
   * Phase 03-A vault-llm-wiki — parallel-shape with `CampaignSettings.dualWrite`.
   * Mirrors the masterBackend / vaultMutations pattern: this field exists on
   * UserPreferences purely for type compatibility with
   * `getSessionMasterPreferences` / `getResolvedPreferences` (both return
   * `Required<UserPreferences>`) — resolution is campaign-only by design
   * (Decision 2 in 03-RESEARCH.md). Never read directly by code; the
   * campaign field is authoritative.
   */
  dualWrite?: boolean;
  /**
   * Phase 03-B vault-llm-wiki — parallel-shape with `CampaignSettings.cutoverAt`.
   * ISO timestamp set by the cutover script (plan 03-B-02). Exists on
   * UserPreferences purely for type compatibility with
   * `Required<UserPreferences>`. Never set on user rows.
   */
  cutoverAt?: string;
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

export type NarrationPace = NonNullable<UserPreferences['narrationPace']>;
export const NARRATION_PACES: NarrationPace[] = ['detailed', 'brisk'];
export function isNarrationPace(v: unknown): v is NarrationPace {
  return typeof v === 'string' && (NARRATION_PACES as string[]).includes(v);
}

export const users = pgTable('users', {
  id: text('id').primaryKey(),                  // Clerk subject (user_xxx)
  displayName: text('display_name'),
  preferences: jsonb('preferences').notNull().default(sql`'{}'::jsonb`).$type<UserPreferences>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
