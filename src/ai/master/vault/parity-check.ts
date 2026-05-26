/**
 * Phase 03-A — synchronous diff between vault-replay state and Postgres
 * engine state.
 *
 * Used by DualWriter (plan 03-A-09) after every apply_event during the
 * dual-write coexistence window. Returns `null` on match; `ParityResult`
 * on divergence. Skip-cases (no events.md, no events for this character,
 * Postgres row missing) also return `null` — skipped checks are NOT
 * recorded as divergences. The audit table is reserved for genuine
 * vault/Postgres disagreements, not for "couldn't compare" cases.
 *
 * The diff is NORMALIZED — arrays sorted, object keys sorted — so that
 * representation quirks (JSONB key reordering, vault sorting via the
 * reducer's deterministic ordering) don't trigger false positives.
 *
 * Comparison field surface (the union of Phase 02 vault state + Phase 03
 * Postgres-side persisted fields):
 *
 *   - hp_current   — `session_state.hpCurrent`    vs vault state
 *   - hp_max       — `characters.hpMax`           vs vault state
 *   - temp_hp      — `session_state.tempHp`       (vault doesn't track yet → defaults to 0 both sides)
 *   - conditions   — `session_state.conditions[].slug` vs vault state
 *   - spell_slots  — assembled from `characters.spellcasting.slotsMax`
 *                                + `characters.spellSlotsUsed`
 *   - inventory    — `characters.inventory[].slug` vs vault state `inventory[].item`
 *   - death_saves  — `session_state.deathSaves`   (vault doesn't track yet → both default)
 *   - flags        — `session_state.flags{stable, dead}` + `characters.inspiration`
 *                    (vault doesn't track flags yet → both default to all-false)
 *   - concentrating_on — `session_state.concentratingOn` (vault doesn't track → both null)
 *   - exhaustion_level — `session_state.exhaustionLevel`  (vault doesn't track → both 0)
 *   - hit_dice_remaining — `session_state.hitDiceRemaining` (vault doesn't track → both 0)
 *   - attunements  — `characters.attunedItems` (NIT 1 fix — the real column;
 *                    vault doesn't track yet → vault side defaults to [])
 *   - resources_used — `characters.resourcesUsed` (vault doesn't track → both default)
 *   - xp           — `characters.xp` (vault doesn't track → both default)
 *   - level        — `characters.level` (vault doesn't track → both default)
 *
 * Fields the vault doesn't yet track are normalized to coherent defaults
 * on BOTH sides so they cannot trigger a false-positive divergence. When
 * Phase 04+ extends `CharacterState` to track e.g. `temp_hp`, this module
 * will need to harvest it from the new vault field. Today the divergence
 * surface is necessarily limited to what the vault projector exposes.
 */
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessionState, characters } from '@/db/schema';
import { parseEventsFile, replayEvents, type CharacterState } from './projector';
import { eventsPath, UUID_REGEX } from './campaign-paths';

/**
 * Result of `parityCheck` when vault and Postgres state DIVERGE.
 *
 * The shape matches the columns of `dual_write_divergences` (plan 03-A-05):
 *   - `vault`    → `dual_write_divergences.vault_state` (jsonb)
 *   - `postgres` → `dual_write_divergences.postgres_state` (jsonb)
 *   - `summary`  → `dual_write_divergences.summary` (text, ≤200 chars)
 *
 * `diverged: true` is a literal-true discriminant so callers can switch
 * on it ergonomically alongside the `null` skip-case.
 */
export interface ParityResult {
  diverged: true;
  /** Human-readable one-line summary (e.g., "hp_current: vault=8, postgres=12"). Capped at 200 chars. */
  summary: string;
  /** Normalized vault-side snapshot at parity-check time (sorted, byte-stable). */
  vault: Record<string, unknown>;
  /** Normalized Postgres-side snapshot at the same moment. */
  postgres: Record<string, unknown>;
}

/**
 * Synchronously diff vault-replay state vs Postgres engine state for one
 * (campaign, character, session) triple. Pure read-only — no writes, no
 * remediation; the audit record is the caller's responsibility (DualWriter
 * plan 03-A-09 wraps this in the divergence-INSERT path).
 *
 * Returns `null` in four skip-cases:
 *   1. `campaignId` is not a UUID (defensive — the dispatcher resolves
 *      `campaignId` from server-side session context, so a malformed
 *      input here is treated as a no-op rather than thrown).
 *   2. `events.md` does not exist for the campaign (campaign hasn't been
 *      flipped to vault yet — no vault side to compare against).
 *   3. No events for this character (character not in any seed; happens
 *      pre-migration or for a campaign that hasn't enabled mutations).
 *   4. Postgres row missing (character was deleted between event write
 *      and parity-check — race window in dual-write).
 *
 * The dual-write window is < 30 days; the cardinality of (events.md size,
 * Postgres rows) is bounded. Parity check is O(events) — typically <1ms
 * for the Phase 02 spike-08 bench (~100 events).
 */
export async function parityCheck(
  campaignId: string,
  characterId: string,
  sessionId: string,
): Promise<ParityResult | null> {
  // === Skip 1: malformed campaignId (`eventsPath` would throw) ===
  if (!UUID_REGEX.test(campaignId)) return null;

  // === Vault side ===
  const eventsFile = eventsPath(campaignId);
  // Skip 2: campaign not on vault yet.
  if (!existsSync(eventsFile)) return null;
  const envelopes = await parseEventsFile(eventsFile);
  if (envelopes.length === 0) return null;
  const states = replayEvents(envelopes);
  const vaultState = states.get(characterId);
  // Skip 3: character not seeded into vault.
  if (!vaultState) return null;

  // === Postgres side ===
  const [pgChar] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  // Skip 4a: character row gone.
  if (!pgChar) return null;

  const [pgState] = await db
    .select()
    .from(sessionState)
    .where(eq(sessionState.sessionId, sessionId))
    .limit(1);
  // Skip 4b: session_state row gone.
  if (!pgState) return null;

  // === Normalize both sides into byte-stable comparable shapes ===
  const vaultNormalized = normalizeVaultState(vaultState);
  const postgresNormalized = normalizePostgresState(pgState, pgChar);

  if (deepEqual(vaultNormalized, postgresNormalized)) return null;

  return {
    diverged: true,
    summary: summarizeDiff(vaultNormalized, postgresNormalized),
    vault: vaultNormalized,
    postgres: postgresNormalized,
  };
}

/**
 * Normalize a vault `CharacterState` into a comparable shape.
 *
 * Sort arrays + sort object keys for byte-stable JSON serialization. The
 * projector ALREADY sorts `conditions`, `inventory`, and (at serialize
 * time) `spell_slots` keys deterministically — we re-sort defensively here
 * so this module is robust against any future projector refactor that
 * drops the invariant.
 *
 * Fields the vault doesn't yet track (`temp_hp`, `death_saves`, etc.) are
 * filled with the same "neutral default" the Postgres side uses, so they
 * cannot trigger a false divergence. The defaults must match the column
 * defaults declared in `src/db/schema/session-state.ts` and
 * `src/db/schema/characters.ts`.
 */
function normalizeVaultState(s: CharacterState): Record<string, unknown> {
  return {
    hp_current: s.hp_current,
    hp_max: s.hp_max,
    temp_hp: 0, // vault doesn't track → match Postgres default
    conditions: [...s.conditions].sort(),
    spell_slots: normalizeSpellSlots(s.spell_slots),
    inventory: normalizeInventoryVault(s.inventory),
    death_saves: { successes: 0, failures: 0 }, // vault doesn't track → match Postgres default
    flags: { stable: false, dead: false, inspiration: false }, // vault doesn't track → defaults
    concentrating_on: null, // vault doesn't track → match Postgres default
    exhaustion_level: 0, // vault doesn't track → match Postgres default
    hit_dice_remaining: 0, // vault doesn't track → would diverge but neutralized for now
    attunements: [], // vault doesn't track → match []
    resources_used: {}, // vault doesn't track → match Postgres default
    xp: 0, // vault doesn't track → match
    level: 1, // vault doesn't track → match Postgres default
  };
}

/**
 * Normalize a Postgres `session_state` + `characters` row pair into the
 * same shape as `normalizeVaultState`.
 *
 * The shape MUST match exactly (same keys, same value types) — any
 * mismatch in key ordering is absorbed by `sortObjectKeys` at the
 * top-level, but key MISSING-on-one-side is a guaranteed false positive.
 *
 * Field source mapping (NIT 1 from plan-check is resolved here):
 *   - `attunements` ← `characters.attunedItems` (NOT a non-existent
 *     `characters.attunements` column)
 *   - `flags.inspiration` ← `characters.inspiration` (top-level boolean,
 *     NOT inside `session_state.flags`)
 *   - `spell_slots`  ← assembled from `characters.spellcasting.slotsMax`
 *                     + `characters.spellSlotsUsed` (matches the vault
 *                     seed shape produced by the flip script)
 *   - `inventory`    ← `characters.inventory` projected to `{item, qty}`
 *                     where `item` is `inventory[].slug` (the vault uses
 *                     `item` as the canonical name; Postgres uses `slug`)
 */
function normalizePostgresState(
  pgState: typeof sessionState.$inferSelect,
  pgChar: typeof characters.$inferSelect,
): Record<string, unknown> {
  return {
    hp_current: pgState.hpCurrent,
    hp_max: pgChar.hpMax,
    temp_hp: pgState.tempHp ?? 0,
    conditions: (pgState.conditions ?? []).map((c) => c.slug).sort(),
    spell_slots: normalizeSpellSlots(
      buildSpellSlots(pgChar.spellcasting?.slotsMax, pgChar.spellSlotsUsed),
    ),
    inventory: normalizeInventoryPostgres(pgChar.inventory ?? []),
    death_saves: pgState.deathSaves ?? { successes: 0, failures: 0 },
    flags: {
      stable: pgState.flags?.stable ?? false,
      dead: pgState.flags?.dead ?? false,
      // NIT 1 resolution: inspiration is `characters.inspiration` (boolean,
      // top-level), NOT a field on `session_state.flags`.
      inspiration: pgChar.inspiration ?? false,
    },
    concentrating_on: pgState.concentratingOn ?? null,
    exhaustion_level: pgState.exhaustionLevel ?? 0,
    hit_dice_remaining: pgState.hitDiceRemaining ?? 0,
    // NIT 1 + NIT 4 resolution: read from `characters.attunedItems` — the
    // real Postgres column shape is `string[]` (slug list), not a JSONB
    // record. Sort defensively so order in the DB doesn't trigger a
    // false-positive against vault's currently-empty list.
    attunements: [...(pgChar.attunedItems ?? [])].sort(),
    resources_used: sortObjectKeys(pgChar.resourcesUsed ?? {}),
    xp: pgChar.xp ?? 0,
    level: pgChar.level ?? 1,
  };
}

/**
 * Assemble a `Record<level, {max, used}>` from the two Postgres columns
 * the flip script uses to source the vault seed (plan 03-A-06 helper
 * `assembleCampaignSeedPayload`). Mirroring that assembly here keeps
 * the parity-check field-shape identical to what the vault sees.
 *
 * Levels with `max === 0` are omitted — the vault seed validator
 * (events-schema.ts) accepts them but the flip script's seed omits
 * non-positive levels, so the vault state Map never contains them.
 */
function buildSpellSlots(
  slotsMax: Record<string, number> | null | undefined,
  slotsUsed: Record<string, number> | null | undefined,
): Record<string, { max: number; used: number }> {
  const out: Record<string, { max: number; used: number }> = {};
  for (const [level, max] of Object.entries(slotsMax ?? {})) {
    if (max > 0) {
      out[level] = { max, used: slotsUsed?.[level] ?? 0 };
    }
  }
  return out;
}

/**
 * Sort the keys of a spell-slots record so JSON.stringify produces a
 * byte-stable representation regardless of insertion order. The shape
 * `{max, used}` is left untouched per-entry — those two keys are always
 * the same pair and the projector always emits them in this order.
 */
function normalizeSpellSlots(
  slots: Record<string, { max: number; used: number }>,
): Record<string, { max: number; used: number }> {
  const out: Record<string, { max: number; used: number }> = {};
  for (const key of Object.keys(slots).sort()) {
    const slot = slots[key]!;
    out[key] = { max: slot.max, used: slot.used };
  }
  return out;
}

/**
 * Vault-side inventory is already `{item: string, qty: number}[]`.
 * Sort by item name so the diff is order-insensitive.
 */
function normalizeInventoryVault(
  inv: { item: string; qty: number }[],
): { item: string; qty: number }[] {
  return [...inv]
    .map((entry) => ({ item: entry.item, qty: entry.qty }))
    .sort((a, b) => a.item.localeCompare(b.item));
}

/**
 * Postgres-side inventory shape is `{slug, qty, equipped}[]` (from
 * `characters.inventory`). Project to `{item, qty}` — `item` is the
 * vault's canonical name for `slug`, and `equipped` is not tracked by
 * the vault yet (Phase 02 inventory events don't carry it). Sort by
 * item for byte-stable output.
 */
function normalizeInventoryPostgres(
  inv: { slug: string; qty: number; equipped?: boolean }[],
): { item: string; qty: number }[] {
  return [...inv]
    .map((entry) => ({ item: entry.slug, qty: entry.qty }))
    .sort((a, b) => a.item.localeCompare(b.item));
}

/**
 * Return a fresh object with the same key/value pairs as `o` but with
 * keys in lexicographic order. `JSON.stringify` walks the in-insertion
 * order, so sorting here makes the stringified output byte-stable.
 */
function sortObjectKeys<T extends Record<string, unknown>>(
  o: T,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Structural equality via canonical JSON. Works for the shapes we
 * compare here (primitives, arrays, plain objects, all keys sorted by
 * the normalizers). Faster than a hand-rolled deep walk at this scale
 * and avoids the `node:util` `isDeepStrictEqual` dependency.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build the human-readable one-line summary for the audit table.
 *
 * Format: `<key>: vault=<json>, postgres=<json>` joined with `; ` per
 * divergent field. Capped at 200 chars (matches the `summary` column
 * width comment in `dual_write_divergences.ts`); the tail is truncated
 * with `...` rather than emitted as-is to keep the audit table readable.
 *
 * Example output:
 *   `hp_current: vault=8, postgres=12`
 *   `hp_current: vault=8, postgres=12; conditions: vault=["poisoned"], postgres=[]`
 */
function summarizeDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string {
  const parts: string[] = [];
  // Walk the union of keys (defensive: callers MIGHT pass differently-
  // shaped objects in a future refactor; today the normalizers guarantee
  // the same key-set on both sides).
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  // Sort the keys so the summary order is stable across runs (deterministic
  // diff is easier to grep + cross-reference in the audit table).
  for (const key of [...allKeys].sort()) {
    const av = JSON.stringify(a[key]);
    const bv = JSON.stringify(b[key]);
    if (av !== bv) {
      parts.push(`${key}: vault=${av}, postgres=${bv}`);
    }
  }
  const s = parts.join('; ');
  // 200-char cap (matches dual_write_divergences.summary contract).
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}
