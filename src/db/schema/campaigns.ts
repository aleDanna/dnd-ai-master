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
  /**
   * Phase 02 vault-llm-wiki — per-campaign opt-in for event-sourced
   * mutations. Orthogonal to `masterBackend` (Decision 5): `masterBackend`
   * picks the LLM tool surface (vault vs baked); `vaultMutations` picks
   * whether the vault path is read-only or read-write.
   *
   * Resolution semantics (per Pitfall 5): `vaultMutations` has no effect
   * unless `masterBackend === 'vault'`. The resolver
   * (`resolveVaultMutations` in `src/lib/preferences.ts`) returns `false`
   * for baked campaigns regardless of the stored value, so flipping this
   * on a baked campaign is a no-op until the campaign is also flipped to
   * `masterBackend: 'vault'`.
   *
   *  - undefined (default) → vault is READ-ONLY for game state (Phase 01
   *    behavior preserved)
   *  - false              → same as undefined
   *  - true               → vault path exposes `apply_event` tool;
   *                         mutations land in events.md per spike 010
   *
   * Locked by REQ-004 (events.md source of truth) + REQ-007 (per-campaign
   * dir under VAULT_CAMPAIGNS_ROOT).
   */
  vaultMutations?: boolean;
  /**
   * Phase 03-B vault-llm-wiki — cutover semantics (Decision 4). Selects
   * which store is the SOURCE OF TRUTH for snapshot reads.
   *  - 'postgres' (default) → buildClientSnapshot reads session_state + characters
   *  - 'vault'              → buildClientSnapshot materializes from events.md replay
   *
   * Preconditions (enforced by scripts/vault-cutover.ts, NOT the resolver):
   *   - masterBackend === 'vault'
   *   - vaultMutations === true
   *
   * State machine (Phase 03):
   *   Pre-migration:    sourceOfTruth=postgres, dualWrite=false
   *   03-A migration:   sourceOfTruth=postgres, dualWrite=true  (writes converge)
   *   03-B cutover:     sourceOfTruth=vault,    dualWrite=true  (reads pivot)
   *   Post-rollback:    sourceOfTruth=vault,    dualWrite=false (Phase 04)
   *
   * Consumed by plan 03-B-07 snapshot read pivot via resolveSourceOfTruth
   * (`src/lib/preferences.ts`). Flipped by plan 03-B-02 cutover script.
   */
  sourceOfTruth?: 'postgres' | 'vault';
  /**
   * Phase 03-A vault-llm-wiki — dual-write coexistence (Decision 2). When
   * true, every apply_event tool call writes to BOTH events.md AND the
   * Postgres engine state, then runs a synchronous parity-check. Used
   * during the coexistence window to validate convergence before cutover.
   *
   * Orthogonal to sourceOfTruth — can be true with either value:
   *  - sourceOfTruth=postgres, dualWrite=true → writes converge, reads stay PG
   *  - sourceOfTruth=vault,    dualWrite=true → writes converge, reads from vault (rollback safety net)
   *
   * Defaults to false (Phase 02 single-write path). Consumed by plan
   * 03-A-10 dual-write dispatch gate via resolveDualWrite
   * (`src/lib/preferences.ts`).
   */
  dualWrite?: boolean;
  /**
   * Phase 03-B audit — ISO timestamp of the most recent sourceOfTruth flip
   * to 'vault'. Used by scripts/vault-cutover.ts (plan 03-B-02) to enforce
   * the CUTOVER_ROLLBACK_HOURS reversibility window. Read-only outside the
   * cutover script.
   */
  cutoverAt?: string;
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
