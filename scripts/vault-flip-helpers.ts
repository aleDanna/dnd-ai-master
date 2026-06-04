/**
 * scripts/vault-flip-helpers.ts — named helpers extracted from
 * `scripts/vault-flip.ts main()` so the per-campaign flip + seed-payload
 * assembly logic is REUSABLE by:
 *
 *   - scripts/migrate-campaigns-to-vault.ts (plan 03-A-07 bulk loop)
 *   - scripts/vault-cutover.ts             (plan 03-B-02 source-of-truth flip)
 *
 * The Phase 02 CLI (`scripts/vault-flip.ts`) now consumes these helpers
 * from its `main()` — operator-visible behavior is unchanged for every
 * existing flag (`--to`, `--enable-mutations`, `--disable-mutations`,
 * combined invocations, the listing mode).
 *
 * Load-bearing invariants preserved verbatim from Phase 02 plan 02-10:
 *
 *   1. **BLOCKER-1 fix.** The seed-payload assembler `assembleCampaignSeedPayload`
 *      uses the SAME LEFT JOIN chain as the original `enableMutations`:
 *      characters ⨝ sessions (on `sessions.characterId = characters.id` AND
 *      `sessions.campaignId = campaign.id`) ⨝ session_state (on
 *      `session_state.sessionId = sessions.id`). `hp_current` lives on
 *      `session_state.hpCurrent` — NOT on characters — and `ORDER BY
 *      sessions.updatedAt DESC` then a JS-side `Map` dedup picks the
 *      most-recent row per character. When no session row exists, `hpCurrent`
 *      is null via LEFT JOIN; the seed OMITS the field; the projector
 *      defaults to `hp_max`.
 *
 *   2. **HP clamp.** `hp_current` is clamped to `[0, hp_max]` defensively
 *      (guards stale `session_state` rows that overshot a manual `hp_max`
 *      decrease — same as the apply_event hp_change reducer).
 *
 *   3. **spell_slots assembly.** Merge of `characters.spellcasting.slotsMax`
 *      (per-level cap; null for non-casters) with `characters.spellSlotsUsed`
 *      (per-level used counter; defaults to `{}`). Non-casters and empty
 *      merged records emit NO `spell_slots` key — the projector defaults to
 *      `{}`.
 *
 *   4. **EventsWriter + projector contract.** `enableMutationsForCampaign`
 *      appends the synthetic `campaign_initialized` envelope via
 *      `EventsWriter.applyEvent` then calls `regenerateAffectedViews`
 *      synchronously — same Decision 2 contract Phase 02 locked.
 *
 *   5. **Pitfall 5 warning.** When `vaultMutations` is enabled on a campaign
 *      whose `masterBackend !== 'vault'`, a `console.warn` is emitted; the
 *      flag is still persisted (storage is idempotent) so a later
 *      `--to=vault` flip activates the path without re-running enable.
 *
 * Phase 03-B-02 (`flipSourceOfTruth`) is the parallel-shape extension for the
 * cutover semantics (Decision 4): `sourceOfTruth: 'postgres' | 'vault'` flip
 * with defensive preconditions (`vault` target requires `masterBackend ===
 * 'vault'` AND `vaultMutations === true`).
 *
 * Idempotency contract (consumed by the plan 03-A-07 bulk migration loop):
 *   - flipCampaignToVault / flipCampaignToBaked / enableMutationsForCampaign
 *     / disableMutationsForCampaign / flipSourceOfTruth all return
 *     `{ ..., changed: boolean }`. A second invocation against a campaign
 *     already in the target state returns `changed: false` and is a no-op
 *     (zero DB writes, zero events.md appends).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns } from '@/db/schema';
import { resolveMasterBackend, type MasterBackend } from '@/lib/preferences';
import type { CampaignSettings } from '@/db/schema';
import { EventsWriter } from '@/ai/master/vault/events-writer';
import { regenerateAffectedViews } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { EVENT_SCHEMA_VERSION } from '@/ai/master/vault/events-schema';
import type { VaultEventEnvelope } from '@/ai/master/vault/events-schema';
// `assembleCampaignSeedPayload` moved to src/campaigns/seed-vault.ts (Phase 07
// hotfix: the production campaign-creation route needs it, and a Next.js route
// must not import from scripts/). Re-exported here so existing importers
// (parity-check, the migration script, this module's tests) are unaffected.
import { assembleCampaignSeedPayload } from '@/campaigns/seed-vault';
export { assembleCampaignSeedPayload };

// ----------------------------------------------------------------------
// Result shapes — consumed by the bulk-migration + cutover scripts for
// audit logging.
// ----------------------------------------------------------------------

export interface FlipBackendResult {
  campaignId: string;
  campaignName: string;
  previousBackend: MasterBackend;
  newBackend: MasterBackend;
  changed: boolean;
}

export interface EnableMutationsResult {
  campaignId: string;
  campaignName: string;
  changed: boolean;
  /** Set only when `changed === true` (we appended the seed event). */
  seedEventId?: string;
  /** Set only when `changed === true`. Number of characters in the payload. */
  charactersSeeded?: number;
}

export interface DisableMutationsResult {
  campaignId: string;
  campaignName: string;
  changed: boolean;
}

export type SourceOfTruth = 'postgres' | 'vault';

export interface FlipSourceOfTruthResult {
  campaignId: string;
  campaignName: string;
  previous: SourceOfTruth;
  next: SourceOfTruth;
  changed: boolean;
}

// ----------------------------------------------------------------------
// Helpers — internal to this module.
// ----------------------------------------------------------------------

/**
 * Local inline resolver for `settings.sourceOfTruth`. The canonical resolver
 * lives in `src/lib/preferences.ts` and is added by plan 03-B-01 (parallel
 * Wave 1 plan). Inlining the trivial default-`'postgres'` resolution here
 * keeps this helpers module independent of 03-B-01's landing order — both
 * plans can land in any sequence within Wave 1 without breaking each other's
 * typecheck. When 03-B-01 has landed, plan 03-B-02 (`scripts/vault-cutover.ts`)
 * is free to import `resolveSourceOfTruth` from preferences for any
 * higher-level resolution it does on its own (e.g., env override surfacing).
 */
function resolveSourceOfTruthLocal(stored: SourceOfTruth | undefined): SourceOfTruth {
  return stored === 'vault' ? 'vault' : 'postgres';
}

interface CampaignRow {
  id: string;
  name: string;
  settings: CampaignSettings;
}

async function loadCampaign(campaignId: string, fnName: string): Promise<CampaignRow> {
  const [row] = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      settings: campaigns.settings,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!row) throw new Error(`${fnName}: campaign ${campaignId} not found`);
  return row;
}

// ----------------------------------------------------------------------
// Public API — flip helpers.
// ----------------------------------------------------------------------

/**
 * Set `settings.masterBackend = 'vault'` for the named campaign.
 *
 * Idempotent: a campaign already on `'vault'` is a no-op (zero DB writes,
 * `changed: false` in the result).
 */
export async function flipCampaignToVault(campaignId: string): Promise<FlipBackendResult> {
  const row = await loadCampaign(campaignId, 'flipCampaignToVault');
  const previousBackend = resolveMasterBackend(row.settings.masterBackend);
  if (previousBackend === 'vault') {
    return {
      campaignId: row.id,
      campaignName: row.name,
      previousBackend,
      newBackend: 'vault',
      changed: false,
    };
  }
  await db
    .update(campaigns)
    .set({
      settings: { ...row.settings, masterBackend: 'vault' as const },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, row.id));
  return {
    campaignId: row.id,
    campaignName: row.name,
    previousBackend,
    newBackend: 'vault',
    changed: true,
  };
}

/**
 * Set `settings.masterBackend = 'baked'` for the named campaign. Symmetric
 * to `flipCampaignToVault` — the CLI `--to=baked` branch consumes this.
 *
 * Idempotent: a campaign already on `'baked'` is a no-op.
 */
export async function flipCampaignToBaked(campaignId: string): Promise<FlipBackendResult> {
  const row = await loadCampaign(campaignId, 'flipCampaignToBaked');
  const previousBackend = resolveMasterBackend(row.settings.masterBackend);
  if (previousBackend === 'baked') {
    return {
      campaignId: row.id,
      campaignName: row.name,
      previousBackend,
      newBackend: 'baked',
      changed: false,
    };
  }
  await db
    .update(campaigns)
    .set({
      settings: { ...row.settings, masterBackend: 'baked' as const },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, row.id));
  return {
    campaignId: row.id,
    campaignName: row.name,
    previousBackend,
    newBackend: 'baked',
    changed: true,
  };
}

/**
 * Enable event-sourced mutations for the named campaign: set
 * `settings.vaultMutations = true`, assemble the seed payload from
 * Postgres, append the synthetic `campaign_initialized` envelope to
 * `events.md`, and regenerate every affected character view.
 *
 * Idempotent: a campaign already on `vaultMutations: true` (with the
 * matching `masterBackend: 'vault'`) is a no-op. The check is done up
 * front; we never re-append the seed event on a re-run.
 *
 * Pitfall 5: enabling vaultMutations on a campaign whose `masterBackend`
 * is still 'baked' is a no-op at runtime — the vault tool surface is not
 * exposed. The flag is still persisted (storage is idempotent) and a
 * `console.warn` informs the operator. This mirrors the Phase 02 CLI
 * behavior so the bulk migration script can rely on the same semantics.
 */
export async function enableMutationsForCampaign(
  campaignId: string,
): Promise<EnableMutationsResult> {
  const row = await loadCampaign(campaignId, 'enableMutationsForCampaign');

  // Idempotency check: if already enabled AND backend is vault, return early.
  // This is what makes the bulk-migration loop (plan 03-A-07) safe to re-run.
  const currentBackend = resolveMasterBackend(row.settings.masterBackend);
  if (row.settings.vaultMutations === true && currentBackend === 'vault') {
    return {
      campaignId: row.id,
      campaignName: row.name,
      changed: false,
    };
  }

  // Pitfall 5 warning: vaultMutations is a no-op unless masterBackend is
  // also 'vault'. We still flip the flag (storage is idempotent) and warn.
  if (currentBackend !== 'vault') {
    console.warn(
      `[vault-flip-helpers] WARN: enabling vaultMutations on a '${currentBackend}' campaign — flag has no effect until masterBackend is also set to vault (Pitfall 5).`,
    );
  }

  // 1. Persist settings.
  const nextSettings = { ...row.settings, vaultMutations: true };
  await db
    .update(campaigns)
    .set({ settings: nextSettings, updatedAt: new Date() })
    .where(eq(campaigns.id, row.id));

  // 2. Assemble seed payload via the shared helper. Centralizing this is
  // the entire point of the Phase 03 refactor: plan 03-A-07 (bulk) and
  // plan 03-B-02 (cutover) consume the SAME function — no per-script
  // re-derivation of the LEFT JOIN chain.
  const seedCharacters = await assembleCampaignSeedPayload(row.id);

  if (seedCharacters.length === 0) {
    console.warn(
      `[vault-flip-helpers] WARN: no characters bound to campaign ${row.id.slice(0, 8)} — seed payload will be empty.`,
    );
  }

  // 3. Construct envelope and append.
  const envelope: VaultEventEnvelope = {
    id: randomUUID(),
    version: EVENT_SCHEMA_VERSION,
    type: 'campaign_initialized',
    payload: { characters: seedCharacters },
    timestamp: new Date().toISOString(),
  };

  // 4. Append via EventsWriter (single-writer mutex per absolute path).
  await EventsWriter.applyEvent(eventsPath(row.id), envelope);

  // 5. Regenerate views for every seeded character.
  await regenerateAffectedViews(row.id, envelope);

  return {
    campaignId: row.id,
    campaignName: row.name,
    changed: true,
    seedEventId: envelope.id,
    charactersSeeded: seedCharacters.length,
  };
}

/**
 * Disable event-sourced mutations: set `settings.vaultMutations = false`.
 * Does NOT delete `events.md` — the durable record stays for re-enablement
 * (a future `enableMutationsForCampaign` call detects the existing flag
 * state and is a no-op on the seed event).
 *
 * Idempotent: a campaign already on `vaultMutations: false` (or never
 * enabled) is a no-op.
 */
export async function disableMutationsForCampaign(
  campaignId: string,
): Promise<DisableMutationsResult> {
  const row = await loadCampaign(campaignId, 'disableMutationsForCampaign');
  if (row.settings.vaultMutations !== true) {
    return { campaignId: row.id, campaignName: row.name, changed: false };
  }
  const nextSettings = { ...row.settings, vaultMutations: false };
  await db
    .update(campaigns)
    .set({ settings: nextSettings, updatedAt: new Date() })
    .where(eq(campaigns.id, row.id));
  return { campaignId: row.id, campaignName: row.name, changed: true };
}

/**
 * Phase 03-B Decision 4 — flip `settings.sourceOfTruth` between `'postgres'`
 * and `'vault'`. Parallel-shape with `flipCampaignToVault` /
 * `flipCampaignToBaked`. Used by plan 03-B-02 `scripts/vault-cutover.ts` as
 * the low-level operation that the higher-level cutover script wraps with
 * audit logging + rollback-window enforcement.
 *
 * Defensive preconditions when targeting `'vault'`:
 *   - `masterBackend === 'vault'` (the vault tool surface must be active)
 *   - `vaultMutations === true`   (the write path must be enabled)
 *
 * These match the state machine documented on `CampaignSettings.sourceOfTruth`:
 *   Pre-migration:  sourceOfTruth=postgres, dualWrite=false
 *   03-A migration: sourceOfTruth=postgres, dualWrite=true
 *   03-B cutover:   sourceOfTruth=vault,    dualWrite=true
 *
 * Idempotent: a campaign already on the target `sourceOfTruth` is a no-op
 * (zero DB writes, `changed: false`). The cutover script's audit log
 * branches on `changed` to decide whether to emit an "already at target"
 * info line vs the full audit row.
 *
 * `cutoverAt` is set to the current ISO timestamp ONLY when transitioning
 * TO `'vault'` (Decision 4 — used by the rollback-window check). The
 * `'postgres'` rollback path PRESERVES the existing `cutoverAt` so the
 * audit trail remains intact.
 */
export async function flipSourceOfTruth(
  campaignId: string,
  target: SourceOfTruth,
): Promise<FlipSourceOfTruthResult> {
  const row = await loadCampaign(campaignId, 'flipSourceOfTruth');
  const previous = resolveSourceOfTruthLocal(row.settings.sourceOfTruth);
  if (previous === target) {
    return {
      campaignId: row.id,
      campaignName: row.name,
      previous,
      next: target,
      changed: false,
    };
  }
  if (target === 'vault') {
    const backend = resolveMasterBackend(row.settings.masterBackend);
    if (backend !== 'vault') {
      throw new Error(
        `flipSourceOfTruth: cannot set sourceOfTruth=vault when masterBackend=${backend}; run vault-flip --to=vault first`,
      );
    }
    if (row.settings.vaultMutations !== true) {
      throw new Error(
        `flipSourceOfTruth: cannot set sourceOfTruth=vault when vaultMutations=false; run vault-flip --enable-mutations first`,
      );
    }
  }
  const now = new Date();
  await db
    .update(campaigns)
    .set({
      settings: {
        ...row.settings,
        sourceOfTruth: target,
        cutoverAt: target === 'vault' ? now.toISOString() : row.settings.cutoverAt,
      },
      updatedAt: now,
    })
    .where(eq(campaigns.id, row.id));
  return {
    campaignId: row.id,
    campaignName: row.name,
    previous,
    next: target,
    changed: true,
  };
}
