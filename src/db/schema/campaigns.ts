import { pgTable, text, uuid, timestamp, pgEnum, varchar, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import type { ProviderName, ImageProviderName } from '@/lib/ai-models';

export const campaignStatusEnum = pgEnum('campaign_status', ['active', 'ended']);

/**
 * Phase 01 vault-llm-wiki feature flag. Selects which knowledge backend
 * the master uses for a given campaign.
 *  - 'baked' (default) — existing baked variant + RAG path
 *  - 'vault'           — markdown-vault path (read-only state in Phase 01;
 *                        Phase 02 adds apply_event for mutation)
 */
export type MasterBackend = 'vault' | 'baked';

export function isMasterBackend(v: unknown): v is MasterBackend {
  return v === 'vault' || v === 'baked';
}

/**
 * Per-campaign game settings, owned by the campaign creator
 * (`campaigns.userId`). Mirrors the shared subset of `UserPreferences`
 * minus `ttsAutoplay` (which stays per-viewer). New campaigns snapshot
 * these from the creator's preferences at creation time; existing rows
 * were backfilled by migration 0031.
 */
export interface CampaignSettings {
  aiProvider?: ProviderName;
  aiMasterModel?: string;
  ttsProvider?: 'openai' | 'gemini' | 'local';
  ttsVoice?: string;
  ttsModel?: string;
  manualRolls?: boolean;
  masterGuidanceLevel?: 'free' | 'balanced' | 'structured';
  showDifficultyNumbers?: boolean;
  narrationPace?: 'detailed' | 'brisk';
  imageGenerationEnabled?: boolean;
  imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
  imageStyleCustom?: string;
  imageProvider?: ImageProviderName;
  imageModel?: string;
  /**
   * When true, the master system prompt uses compact variants of the SRD
   * + handbook + world lore (Plan C). Trades narrative depth for raw
   * latency on small local models. When undefined, defaults to true for
   * `aiProvider === 'local'` and false for cloud providers (where the
   * full prompt fits comfortably under the model's context).
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
   * Phase 01 feature flag (vault-llm-wiki migration). Selects which
   * knowledge backend the master uses for this campaign.
   *  - 'baked' (default) → existing baked variant + RAG path (system_prompt.ts → tool-loop.ts → engine tools)
   *  - 'vault'           → markdown-vault path (vault/prompt-builder.ts → vault/loop.ts → vault tools, NO engine tools)
   * When 'vault', game-state mutation is unavailable (Phase 02 adds apply_event).
   */
  masterBackend?: MasterBackend;
}

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    premise: text('premise').notNull(),
    style: varchar('style', { length: 16 }).notNull().default('improv'),
    language: text('language'),
    tonalFrame: varchar('tonal_frame', { length: 32 }),
    engagementProfile: jsonb('engagement_profile').$type<string[]>().notNull().default([]),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`).$type<CampaignSettings>(),
    status: campaignStatusEnum('status').notNull().default('active'),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusIdx: index('campaigns_user_status_idx').on(t.userId, t.status),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignInsert = typeof campaigns.$inferInsert;
