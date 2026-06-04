/**
 * src/campaigns/seed-vault.ts — vault genesis seeding.
 *
 * Writes the `campaign_initialized` seed event for a campaign, idempotent on
 * the ACTUAL events.md genesis (NOT the settings flag).
 *
 * WHY THIS EXISTS — the creation-flow seeding bug it fixes:
 * New campaigns are born `masterBackend='vault'` + `vaultMutations=true` (see
 * `initial-settings.ts`, commit fe50485 "born fully playable"). The only seed
 * writer used to be `scripts/vault-flip-helpers.ts#enableMutationsForCampaign`,
 * whose idempotency is keyed on the FLAG:
 *     if (settings.vaultMutations === true && backend === 'vault') return;  // skip
 * So for a campaign born with the flag already set, that writer early-returns
 * and the `campaign_initialized` genesis is NEVER written. A campaign with no
 * genesis cannot be materialized: `materializeFromVault` fails to resolve the
 * viewer PC, returns null, and `buildClientSnapshot` silently falls back to
 * Postgres (inCombat=false, no encounter) → the CombatTracker never renders and
 * the PC's vault state is wrong. Migrated campaigns escaped the bug only because
 * they started `vaultMutations=false` (the flag flip wrote the seed).
 *
 * `seedCampaignVault` keys idempotency on the genesis event itself, so it is
 * correct whether the campaign is brand-new (empty events.md → genesis becomes
 * the first event) or already flagged. It is wired into the campaign-creation
 * route (`POST /api/campaigns`) AFTER the creation transaction commits — the
 * filesystem seed must not run inside the DB tx (see `forge.ts`).
 *
 * `assembleCampaignSeedPayload` is the BLOCKER-1 LEFT JOIN ground-truth
 * assembler lifted here VERBATIM from `scripts/vault-flip-helpers.ts` (Phase 02
 * plan 02-10) so the operator scripts AND the production creation route consume
 * ONE definition. The scripts re-export it for backward compatibility.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters, sessions, sessionState } from '@/db/schema';
import { EventsWriter } from '@/ai/master/vault/events-writer';
import { regenerateAffectedViews, parseEventsFile } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { EVENT_SCHEMA_VERSION } from '@/ai/master/vault/events-schema';
import type { VaultEventEnvelope, VaultSeedCharacter } from '@/ai/master/vault/events-schema';

/**
 * Assemble the `campaign_initialized` seed payload from Postgres for the named
 * campaign.
 *
 * This is the BLOCKER-1 fix from Phase 02 plan 02-10. Two non-obvious shapes
 * (preserved from the original implementation — do NOT simplify without
 * re-spiking):
 *
 *   1. `hp_current` lives on `session_state.hpCurrent` (per session, NOT per
 *      character). The query LEFT JOINs `sessions.campaignId = campaign.id` AND
 *      `sessions.characterId = characters.id`, then LEFT JOINs
 *      `session_state.sessionId = sessions.id`, then `ORDER BY
 *      sessions.updatedAt DESC` puts the most-recent session row first per
 *      character. The JS-side `Map` dedup (with `[...rows].reverse()` so
 *      `Map.set`'s LAST-wins semantics produce a FIRST-wins effective ordering)
 *      keeps the most-recent row per character id. When no session row exists,
 *      the LEFT JOIN leaves `hpCurrent` null, and the seed OMITS `hp_current` —
 *      the projector defaults to `hp_max` (full HP) via `INITIAL_CHARACTER_STATE`.
 *
 *   2. `spell_slots` is assembled from `characters.spellcasting.slotsMax`
 *      (per-level cap, may be null for non-casters) merged with
 *      `characters.spellSlotsUsed` (per-level counter, defaults to `{}`).
 *      Non-casters (`spellcasting: null`) and empty merged records emit NO
 *      `spell_slots` key — the projector defaults to `{}`.
 */
export async function assembleCampaignSeedPayload(
  campaignId: string,
): Promise<VaultSeedCharacter[]> {
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      hpMax: characters.hpMax,
      spellcasting: characters.spellcasting,
      spellSlotsUsed: characters.spellSlotsUsed,
      hpCurrent: sessionState.hpCurrent, // nullable via LEFT JOIN
    })
    .from(characters)
    .leftJoin(
      sessions,
      and(eq(sessions.characterId, characters.id), eq(sessions.campaignId, campaignId)),
    )
    .leftJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .where(eq(characters.campaignId, campaignId))
    .orderBy(desc(sessions.updatedAt));

  // Dedup: keep ONE row per character (the most-recent one because of the
  // ORDER BY). `new Map(entries)` keeps the LAST set value for a key, so we
  // reverse the rows to ensure the FIRST (most-recent) wins after dedup.
  const dedupedRows = Array.from(
    new Map([...rows].reverse().map((r) => [r.id, r] as const)).values(),
  ).reverse();

  return dedupedRows.map((r) => {
    const seed: VaultSeedCharacter = {
      id: r.id,
      name: r.name,
      hp_max: r.hpMax,
    };

    if (typeof r.hpCurrent === 'number' && Number.isInteger(r.hpCurrent)) {
      seed.hp_current = Math.max(0, Math.min(r.hpMax, r.hpCurrent));
    }

    if (r.spellcasting && r.spellcasting.slotsMax) {
      const slotsMax: Record<string, number> = r.spellcasting.slotsMax;
      const slotsUsed: Record<string, number> = r.spellSlotsUsed ?? {};
      const merged: Record<string, { max: number; used: number }> = {};
      for (const level of Object.keys(slotsMax)) {
        const max = slotsMax[level] ?? 0;
        if (max <= 0) continue;
        const used = Math.max(0, Math.min(max, slotsUsed[level] ?? 0));
        merged[level] = { max, used };
      }
      if (Object.keys(merged).length > 0) {
        seed.spell_slots = merged;
      }
    }

    return seed;
  });
}

export interface SeedCampaignVaultResult {
  /** True when a genesis was written by this call; false when skipped. */
  seeded: boolean;
  /** Set only when `seeded === true`. */
  seedEventId?: string;
  /** Set only when `seeded === true`. Number of characters in the payload. */
  charactersSeeded?: number;
}

/**
 * Write the `campaign_initialized` genesis for a campaign — idempotent on the
 * EVENT (not the settings flag).
 *
 * No-op (returns `{ seeded: false }`) when:
 *   - events.md already holds a `campaign_initialized` envelope (genesis exists), or
 *   - no characters are bound to the campaign (an empty genesis would not
 *     resolve `materializeFromVault`, so writing it is pointless).
 *
 * On a brand-new campaign (no events.md yet) the genesis becomes the first
 * event. Re-seeding a campaign that already accrued events appends the genesis;
 * the projector still seeds the character map on replay, which is what
 * `materializeFromVault` needs to stop falling back to Postgres.
 *
 * Writes via `EventsWriter.applyEvent` (single-writer mutex per absolute path)
 * then regenerates the affected character views synchronously.
 */
export async function seedCampaignVault(
  campaignId: string,
): Promise<SeedCampaignVaultResult> {
  // Idempotency keyed on the genesis event, NOT settings.vaultMutations.
  try {
    const existing = await parseEventsFile(eventsPath(campaignId));
    if (existing.some((e) => e.type === 'campaign_initialized')) {
      return { seeded: false };
    }
  } catch {
    // No events.md yet (brand-new campaign) → fall through and seed.
  }

  const seedCharacters = await assembleCampaignSeedPayload(campaignId);
  if (seedCharacters.length === 0) {
    return { seeded: false };
  }

  const envelope: VaultEventEnvelope = {
    id: randomUUID(),
    version: EVENT_SCHEMA_VERSION,
    type: 'campaign_initialized',
    payload: { characters: seedCharacters },
    timestamp: new Date().toISOString(),
  };

  await EventsWriter.applyEvent(eventsPath(campaignId), envelope);
  await regenerateAffectedViews(campaignId, envelope);

  return {
    seeded: true,
    seedEventId: envelope.id,
    charactersSeeded: seedCharacters.length,
  };
}
