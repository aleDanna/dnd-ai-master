/**
 * Phase 02 — Event schema for the vault write path.
 *
 * REQ-005 — Mutations go through `EventsWriter`. This module defines the
 *           SHAPE of every event the writer accepts: a TypeScript
 *           discriminated union (`VaultEvent`) + a runtime guard
 *           (`validateEvent`) that the `apply_event` dispatcher (plan 02-07)
 *           runs at the LLM-→-server boundary before any append.
 * REQ-010 — Fixed 4-tool surface (`apply_event` is the 4th). This module
 *           defines the schema for that tool's `payload`.
 *
 * Design — Decision 1 from .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md:
 *   Hand-rolled type guards, no `zod` dependency. The validation surface is
 *   small (7 mutation event types + 1 seed event), the union is closed at
 *   compile time, and the projector's `default:` switch arm forces a tsc
 *   error whenever a new union member is added without a corresponding
 *   reducer case (Pitfall 6 — graceful schema drift across releases).
 *
 * The union is OPEN for extension via the projector's `default` case
 * (Pitfall 6): events.md may carry event types from a future schema
 * version; the projector logs unknown types without throwing so replay can
 * complete with possibly-stale state. Compile-time exhaustiveness still
 * holds for *known* members.
 *
 * Seed event — Decision 9:
 *   The 8th type `campaign_initialized` is the seed emitted by the
 *   `vault:flip` script (plan 02-10) when a Postgres-backed campaign is
 *   migrated onto the vault write path. The shape mirrors what the flip
 *   script can actually assemble from the live Postgres schema:
 *
 *   - `hp_max` is ALWAYS present — sourced from `characters.hpMax` (NOT NULL).
 *   - `hp_current` is OPTIONAL — sourced from `session_state.hpCurrent` of
 *     the most-recent active session for the campaign. A brand-new campaign
 *     with no played session has no `session_state` row, so the flip script
 *     omits this field and the projector falls back to `hp_max` in its
 *     `INITIAL_CHARACTER_STATE`.
 *   - `spell_slots` is OPTIONAL — assembled from
 *     `characters.spellcasting.slotsMax` (per-level cap, may be null on
 *     non-casters) merged with `characters.spellSlotsUsed` (per-level used
 *     counter, defaults to `{}`). Non-casters have `spellcasting: null`
 *     and produce an empty record, in which case the flip script omits the
 *     field and the projector falls back to `{}`.
 *
 *   Keeping `hp_current` and `spell_slots` optional in the validator is
 *   the load-bearing decision: brand-new campaigns and non-caster PCs can
 *   still produce a valid seed event without the flip script having to
 *   fabricate placeholder data.
 *
 * Phase 03 extension — Decision 10 (Completeness Audit):
 *   Phase 03-A-01 audited every `TOOL_HANDLERS` entry in
 *   `src/engine/tools/handlers.ts` and identified additional mutation
 *   patterns that have no Phase 02 event-type coverage (Pitfall 1 —
 *   without these, dual-write divergence rate is ~100% on combat turns).
 *   The (c) Final list from `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md`
 *   is shipped as additive union members + validator cases here. The
 *   projector's reducer arms (`applyEvent` in plan 03-A-03) consume the
 *   new types. EVENT_SCHEMA_VERSION stays at 1 — additions are NOT
 *   breaking (in-flight events.md files retain the Phase 02 graceful-
 *   degradation default arm for unknown types).
 *
 *   The 20 new types are (in audit order):
 *     1. temp_hp_set                — tempHp absorption / long-rest reset
 *     2. death_save_success         — single success roll
 *     3. death_save_fail            — single failure roll (critical: 2x)
 *     4. death_save_stabilize       — manual stabilize, preserves unconscious
 *     5. death_save_recover_at_one  — nat20 atomic recovery (HP=1, drop saves)
 *     6. concentration_set          — spell with concentration tag cast
 *     7. concentration_break        — save fail / killed / incapacitated
 *     8. exhaustion_increment       — forced march / starvation / dehydration
 *     9. exhaustion_decrement       — long-rest tick / direct remove
 *    10. hit_dice_use               — short-rest die spend
 *    11. hit_dice_restore           — long-rest restore (level/2 dice)
 *    12. resource_use               — generic per-feature counter (rage, surge,
 *                                     channel divinity, bardic, lay-on-hands)
 *    13. resource_restore           — short/long-rest resource refresh
 *    14. inspiration_grant          — DM grants the inspiration token
 *    15. inspiration_spend          — PC spends inspiration (check/save/attack)
 *    16. attune                     — magic item attunement
 *    17. unattune                   — magic item de-attunement
 *    18. focus_set                  — arcane/druidic/holy/instrument focus
 *    19. focus_unset                — clear equipped focus
 *    20. xp_award                   — DM awards XP (reason metadata)
 *
 * Envelope — spike 008 §"Decision-grade implications":
 *   Every event has `{id, version, type, payload, timestamp}`. `version`
 *   defaults to `EVENT_SCHEMA_VERSION = 1`; Phase 03 can bump and add
 *   migrations. `id` is a `crypto.randomUUID()` allocated by the
 *   dispatcher (plan 02-07). `timestamp` is `new Date().toISOString()` —
 *   metadata only, not consumed by the pure projector (RESEARCH Pattern 2).
 *
 * No imports — this module is pure logic, importable from a Vitest test
 * that runs without `DATABASE_URL` (no DB types, no env reads, no side
 * effects).
 */

/**
 * Bump this when the event payload shape changes incompatibly. Phase 02
 * ships at version 1; Phase 03+ may introduce a `2` with migration logic
 * keyed off the envelope's `version` field.
 */
export const EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Canonical list of every known event type — 7 mutation events + the
 * `campaign_initialized` seed (Decision 9). Const tuple so callers can
 * derive `VaultEventType` from `typeof [number]`.
 *
 * Order matters for stable output in `phase-smoke` tests and for the
 * dispatcher's switch arms (plan 02-07). Do NOT reorder casually.
 */
export const VAULT_EVENT_TYPES = [
  // Phase 02 (unchanged — 8 types)
  'hp_change',
  'condition_add',
  'condition_remove',
  'spell_slot_use',
  'spell_slot_restore',
  'inventory_add',
  'inventory_remove',
  'campaign_initialized',
  // Phase 03 (new — from COMPLETENESS-AUDIT.md (c) Final list, in audit order)
  'temp_hp_set',
  'death_save_success',
  'death_save_fail',
  'death_save_stabilize',
  'death_save_recover_at_one',
  'concentration_set',
  'concentration_break',
  'exhaustion_increment',
  'exhaustion_decrement',
  'hit_dice_use',
  'hit_dice_restore',
  'resource_use',
  'resource_restore',
  'inspiration_grant',
  'inspiration_spend',
  'attune',
  'unattune',
  'focus_set',
  'focus_unset',
  'xp_award',
] as const;

export type VaultEventType = (typeof VAULT_EVENT_TYPES)[number];

/**
 * O(1) lookup set for `isVaultEventType`. Built once at module load.
 * Typed as `Set<string>` so `has(value)` accepts the `unknown` payloads
 * the dispatcher feeds in without `value as VaultEventType` casts.
 */
const VAULT_EVENT_TYPES_SET: Set<string> = new Set<string>(VAULT_EVENT_TYPES);

/**
 * Narrow `unknown` to `VaultEventType` by checking membership in
 * `VAULT_EVENT_TYPES`. Used by the dispatcher (plan 02-07) BEFORE calling
 * `validateEvent`, so the error message can distinguish "unknown event
 * type" from "malformed payload for a known type".
 */
export function isVaultEventType(value: unknown): value is VaultEventType {
  return typeof value === 'string' && VAULT_EVENT_TYPES_SET.has(value);
}

/**
 * One character entry inside the `campaign_initialized` seed payload.
 *
 * Required fields = the schema-mandated minimum the flip script can
 * always produce from Postgres. Optional fields = state that may not
 * exist for brand-new campaigns or non-caster PCs (see module-level
 * JSDoc for the full rationale).
 *
 * Phase 02 fields:
 *   - `hp_current` absent → projector defaults to `hp_max`
 *   - `spell_slots` absent → projector defaults to `{}`
 *
 * Phase 03 additions (plan 03-A-03 — all OPTIONAL):
 *   - `temp_hp`            ← session_state.temp_hp (defaults to 0)
 *   - `hit_dice_remaining` ← session_state.hit_dice_remaining (defaults to 0)
 *   - `hit_dice_max`       ← characters.hit_dice_max (1 die per level; defaults to 0)
 *   - `exhaustion_level`   ← session_state.exhaustion_level (defaults to 0)
 *   - `death_saves`        ← session_state.death_saves (defaults to {s:0, f:0})
 *   - `flags`              ← session_state.flags + characters.inspiration merged
 *   - `concentrating_on`   ← session_state.concentrating_on (defaults to null)
 *   - `attunements`        ← characters.attuned_items (defaults to [])
 *   - `equipped_focus`     ← characters.equipped_focus (defaults to null)
 *   - `resources_used`     ← characters.resources_used (defaults to {})
 *   - `xp`                 ← characters.xp (defaults to 0)
 *   - `level`              ← characters.level (defaults to 1)
 *
 * All optional — vault-flip's LEFT JOIN may omit them. The projector
 * falls back to sane defaults so brand-new campaigns and never-played
 * sessions still produce a valid seed state.
 */
export type VaultSeedCharacter = {
  id: string;
  name: string;
  hp_max: number;
  /**
   * Optional. Sourced from `session_state.hpCurrent` for the most-recent
   * active session of the campaign at flip time (plan 02-10). When the
   * campaign has no played session yet (no `session_state` row), the flip
   * script omits this field and the projector falls back to `hp_max`.
   */
  hp_current?: number;
  /**
   * Optional. Assembled by the flip script from
   * `characters.spellcasting.slotsMax` (per-level cap) merged with
   * `characters.spellSlotsUsed` (per-level used counter). Non-casters
   * have `spellcasting: null` and produce an empty record — the flip
   * script omits the field in that case and the projector falls back
   * to `{}`.
   */
  spell_slots?: Record<string, { max: number; used: number }>;
  /** Optional — session_state.temp_hp. Defaults to 0. */
  temp_hp?: number;
  /** Optional — session_state.hit_dice_remaining. Defaults to 0. */
  hit_dice_remaining?: number;
  /** Optional — characters.hit_dice_max. Defaults to 0. */
  hit_dice_max?: number;
  /** Optional — session_state.exhaustion_level. Defaults to 0. */
  exhaustion_level?: number;
  /** Optional — session_state.death_saves. Defaults to {successes:0, failures:0}. */
  death_saves?: { successes: number; failures: number };
  /**
   * Optional — merged from `session_state.flags` (`stable`, `dead`) and
   * `characters.inspiration` (top-level boolean). All three default to
   * `false` when absent.
   */
  flags?: { stable?: boolean; dead?: boolean; inspiration?: boolean };
  /** Optional — session_state.concentrating_on. Defaults to null. */
  concentrating_on?: { spellSlug: string; slotLevel: number; startedRound: number } | null;
  /** Optional — characters.attuned_items. Defaults to []. */
  attunements?: string[];
  /** Optional — characters.equipped_focus. Defaults to null. */
  equipped_focus?: { kind: 'arcane' | 'druidic' | 'holy' | 'instrument'; itemSlug: string } | null;
  /** Optional — characters.resources_used. Defaults to {}. */
  resources_used?: Record<string, number>;
  /** Optional — characters.xp. Defaults to 0. */
  xp?: number;
  /** Optional — characters.level. Defaults to 1. */
  level?: number;
};

/**
 * The discriminated union covering every known event type.
 *
 * Compile-time exhaustiveness: any reducer (the projector's `applyEvent`
 * in plan 02-04) must exhaust every union member or the `default:` arm's
 * `never` typing surfaces a tsc error.
 *
 * Run-time exhaustiveness: see `validateEvent` below.
 */
export type VaultEvent =
  // Phase 02 (unchanged)
  | { type: 'hp_change'; payload: { character: string; delta: number } }
  | { type: 'condition_add'; payload: { character: string; condition: string } }
  | { type: 'condition_remove'; payload: { character: string; condition: string } }
  | { type: 'spell_slot_use'; payload: { character: string; level: number } }
  | { type: 'spell_slot_restore'; payload: { character: string; level: number } }
  | { type: 'inventory_add'; payload: { character: string; item: string; qty: number } }
  | { type: 'inventory_remove'; payload: { character: string; item: string; qty: number } }
  | { type: 'campaign_initialized'; payload: { characters: VaultSeedCharacter[] } }
  // Phase 03 (new — see COMPLETENESS-AUDIT.md §"(c) Detailed event-type specifications")
  | { type: 'temp_hp_set'; payload: { character: string; tempHp: number } }
  | { type: 'death_save_success'; payload: { character: string } }
  | { type: 'death_save_fail'; payload: { character: string; critical?: boolean } }
  | { type: 'death_save_stabilize'; payload: { character: string } }
  | { type: 'death_save_recover_at_one'; payload: { character: string } }
  | {
      type: 'concentration_set';
      payload: {
        character: string;
        spellSlug: string;
        slotLevel: number;
        startedRound: number;
      };
    }
  | {
      type: 'concentration_break';
      payload: { character: string; reason: 'damage' | 'killed' | 'incapacitated' };
    }
  | { type: 'exhaustion_increment'; payload: { character: string; source: string } }
  | { type: 'exhaustion_decrement'; payload: { character: string } }
  | { type: 'hit_dice_use'; payload: { character: string; count: number } }
  | { type: 'hit_dice_restore'; payload: { character: string; count: number } }
  | { type: 'resource_use'; payload: { character: string; resourceKey: string; uses: number } }
  | { type: 'resource_restore'; payload: { character: string; resourceKey: string; uses: number } }
  | { type: 'inspiration_grant'; payload: { character: string } }
  | { type: 'inspiration_spend'; payload: { character: string } }
  | { type: 'attune'; payload: { character: string; itemSlug: string } }
  | { type: 'unattune'; payload: { character: string; itemSlug: string } }
  | {
      type: 'focus_set';
      payload: {
        character: string;
        kind: 'arcane' | 'druidic' | 'holy' | 'instrument';
        itemSlug: string;
      };
    }
  | { type: 'focus_unset'; payload: { character: string } }
  | { type: 'xp_award'; payload: { character: string; amount: number; reason?: string } };

/**
 * On-disk envelope persisted to `events.md` (one JSON-line per event).
 *
 * - `id` — `crypto.randomUUID()` allocated by the dispatcher (plan 02-07).
 *          Enables idempotent retries — spike 008 §"Idempotent event
 *          application".
 * - `version` — `EVENT_SCHEMA_VERSION` literal (currently `1`). Phase 03
 *               bumps to `2` if the payload shape changes.
 * - `type` — one of `VAULT_EVENT_TYPES`.
 * - `payload` — the matching member of `VaultEvent['payload']`.
 * - `timestamp` — ISO-8601 string (`new Date().toISOString()`). Metadata
 *                 only; the projector is pure and does NOT consume this.
 */
export interface VaultEventEnvelope {
  id: string;
  version: typeof EVENT_SCHEMA_VERSION;
  type: VaultEventType;
  payload: VaultEvent['payload'];
  timestamp: string;
}

/**
 * Result of `validateEvent`. On success, `value` is the strongly-typed
 * narrow `VaultEvent`. On failure, `error` is a human-readable string the
 * LLM can use to self-correct (mirrors spike 009's "per-file errors don't
 * fail the batch" — errors are reported back, not thrown).
 */
export type ValidateEventResult =
  | { ok: true; value: VaultEvent }
  | { ok: false; error: string };

/**
 * Internal: typed view onto an `unknown` payload for property access
 * inside the validator. Keeps the per-case body free of `as any` casts.
 */
type RawPayload = Record<string, unknown>;

/**
 * Returns `true` when `value` is a plain object suitable for property
 * access (not `null`, not an array, not a primitive). The runtime
 * `typeof null === 'object'` and `Array.isArray(payload)` cases are the
 * common LLM mistakes the dispatcher needs to reject explicitly.
 */
function isPlainObject(value: unknown): value is RawPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime validator + type narrower for events at the LLM-→-server
 * boundary.
 *
 * Returns `{ ok: true, value: <narrowed VaultEvent> }` on success or
 * `{ ok: false, error: <reason> }` on any malformed input. Never throws.
 *
 * Per-type validation rules (see acceptance criteria in plan 02-01):
 *
 *   - `hp_change`: character non-empty string, delta finite number.
 *     `delta` is NOT bounded at the schema layer — the projector clamps
 *     to `[0, hp_max]` (T-02-03 mitigation in the phase threat model).
 *   - `condition_add` / `condition_remove`: character non-empty string,
 *     condition non-empty string.
 *   - `spell_slot_use` / `spell_slot_restore`: character non-empty
 *     string, level integer in `[1, 9]` (D&D spell slot levels).
 *   - `inventory_add` / `inventory_remove`: character non-empty string,
 *     item non-empty string, qty integer in `(0, 1000)` — T-02-03
 *     mitigation bounding payload size to prevent runaway state growth.
 *   - `campaign_initialized`: payload.characters is a non-array of valid
 *     `VaultSeedCharacter` entries (see `VaultSeedCharacter` JSDoc).
 */
export function validateEvent(input: { type: string; payload: unknown }): ValidateEventResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'event must be an object with {type, payload}' };
  }
  if (typeof input.type !== 'string') {
    return { ok: false, error: 'event.type must be a string' };
  }
  if (!isVaultEventType(input.type)) {
    return { ok: false, error: `unknown event type: ${input.type}` };
  }
  if (!isPlainObject(input.payload)) {
    return { ok: false, error: `event.payload must be a non-null object (got ${input.payload === null ? 'null' : typeof input.payload})` };
  }
  const p: RawPayload = input.payload;

  switch (input.type) {
    case 'hp_change': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'hp_change requires {character: non-empty string, delta: number}' };
      }
      if (typeof p.delta !== 'number' || !Number.isFinite(p.delta)) {
        return { ok: false, error: 'hp_change requires {character: non-empty string, delta: number}' };
      }
      return {
        ok: true,
        value: { type: 'hp_change', payload: { character: p.character, delta: p.delta } },
      };
    }

    case 'condition_add': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'condition_add requires {character: non-empty string, condition: non-empty string}' };
      }
      if (typeof p.condition !== 'string' || p.condition.length === 0) {
        return { ok: false, error: 'condition_add requires {character: non-empty string, condition: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'condition_add', payload: { character: p.character, condition: p.condition } },
      };
    }

    case 'condition_remove': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'condition_remove requires {character: non-empty string, condition: non-empty string}' };
      }
      if (typeof p.condition !== 'string' || p.condition.length === 0) {
        return { ok: false, error: 'condition_remove requires {character: non-empty string, condition: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'condition_remove', payload: { character: p.character, condition: p.condition } },
      };
    }

    case 'spell_slot_use': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'spell_slot_use requires {character: non-empty string, level: integer in [1, 9]}' };
      }
      if (
        typeof p.level !== 'number' ||
        !Number.isInteger(p.level) ||
        p.level < 1 ||
        p.level > 9
      ) {
        return { ok: false, error: 'spell_slot_use requires {character: non-empty string, level: integer in [1, 9]}' };
      }
      return {
        ok: true,
        value: { type: 'spell_slot_use', payload: { character: p.character, level: p.level } },
      };
    }

    case 'spell_slot_restore': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'spell_slot_restore requires {character: non-empty string, level: integer in [1, 9]}' };
      }
      if (
        typeof p.level !== 'number' ||
        !Number.isInteger(p.level) ||
        p.level < 1 ||
        p.level > 9
      ) {
        return { ok: false, error: 'spell_slot_restore requires {character: non-empty string, level: integer in [1, 9]}' };
      }
      return {
        ok: true,
        value: { type: 'spell_slot_restore', payload: { character: p.character, level: p.level } },
      };
    }

    case 'inventory_add': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'inventory_add requires {character: non-empty string, item: non-empty string, qty: integer in (0, 1000)}' };
      }
      if (typeof p.item !== 'string' || p.item.length === 0) {
        return { ok: false, error: 'inventory_add requires {character: non-empty string, item: non-empty string, qty: integer in (0, 1000)}' };
      }
      if (
        typeof p.qty !== 'number' ||
        !Number.isInteger(p.qty) ||
        p.qty <= 0 ||
        p.qty >= 1000
      ) {
        return { ok: false, error: 'inventory_add requires {character: non-empty string, item: non-empty string, qty: integer in (0, 1000)}' };
      }
      return {
        ok: true,
        value: {
          type: 'inventory_add',
          payload: { character: p.character, item: p.item, qty: p.qty },
        },
      };
    }

    case 'inventory_remove': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'inventory_remove requires {character: non-empty string, item: non-empty string, qty: integer in (0, 1000)}' };
      }
      if (typeof p.item !== 'string' || p.item.length === 0) {
        return { ok: false, error: 'inventory_remove requires {character: non-empty string, item: non-empty string, qty: integer in (0, 1000)}' };
      }
      if (
        typeof p.qty !== 'number' ||
        !Number.isInteger(p.qty) ||
        p.qty <= 0 ||
        p.qty >= 1000
      ) {
        return { ok: false, error: 'inventory_remove requires {character: non-empty string, item: non-empty string, qty: integer in (0, 1000)}' };
      }
      return {
        ok: true,
        value: {
          type: 'inventory_remove',
          payload: { character: p.character, item: p.item, qty: p.qty },
        },
      };
    }

    case 'campaign_initialized': {
      if (!Array.isArray(p.characters)) {
        return { ok: false, error: 'campaign_initialized requires {characters: VaultSeedCharacter[]}' };
      }
      const seed: VaultSeedCharacter[] = [];
      for (let i = 0; i < p.characters.length; i++) {
        const entry: unknown = p.characters[i];
        if (!isPlainObject(entry)) {
          return { ok: false, error: `campaign_initialized.characters[${i}] must be an object` };
        }
        const c: RawPayload = entry;

        // REQUIRED: id
        if (typeof c.id !== 'string' || c.id.length === 0) {
          return { ok: false, error: `campaign_initialized.characters[${i}].id must be a non-empty string` };
        }
        // REQUIRED: name
        if (typeof c.name !== 'string' || c.name.length === 0) {
          return { ok: false, error: `campaign_initialized.characters[${i}].name must be a non-empty string` };
        }
        // REQUIRED: hp_max — positive integer
        if (
          typeof c.hp_max !== 'number' ||
          !Number.isInteger(c.hp_max) ||
          c.hp_max <= 0
        ) {
          return { ok: false, error: `campaign_initialized.characters[${i}].hp_max must be a positive integer` };
        }

        const seedEntry: VaultSeedCharacter = {
          id: c.id,
          name: c.name,
          hp_max: c.hp_max,
        };

        // OPTIONAL: hp_current — if present, integer in [0, hp_max]
        if (c.hp_current !== undefined) {
          if (
            typeof c.hp_current !== 'number' ||
            !Number.isInteger(c.hp_current) ||
            c.hp_current < 0 ||
            c.hp_current > c.hp_max
          ) {
            return { ok: false, error: `campaign_initialized.characters[${i}].hp_current must be an integer in [0, hp_max]` };
          }
          seedEntry.hp_current = c.hp_current;
        }

        // OPTIONAL: spell_slots — if present, non-array object with valid entries
        if (c.spell_slots !== undefined) {
          if (!isPlainObject(c.spell_slots)) {
            return { ok: false, error: `campaign_initialized.characters[${i}].spell_slots must be an object keyed by level` };
          }
          const slots: Record<string, { max: number; used: number }> = {};
          for (const lvl of Object.keys(c.spell_slots)) {
            const slot: unknown = (c.spell_slots as RawPayload)[lvl];
            if (!isPlainObject(slot)) {
              return { ok: false, error: `campaign_initialized.characters[${i}].spell_slots[${lvl}] must be an object` };
            }
            const sMax: unknown = slot.max;
            const sUsed: unknown = slot.used;
            if (
              typeof sMax !== 'number' ||
              !Number.isInteger(sMax) ||
              sMax < 0
            ) {
              return { ok: false, error: `campaign_initialized.characters[${i}].spell_slots[${lvl}].max must be a non-negative integer` };
            }
            if (
              typeof sUsed !== 'number' ||
              !Number.isInteger(sUsed) ||
              sUsed < 0
            ) {
              return { ok: false, error: `campaign_initialized.characters[${i}].spell_slots[${lvl}].used must be a non-negative integer` };
            }
            if (sUsed > sMax) {
              return { ok: false, error: `campaign_initialized.characters[${i}].spell_slots[${lvl}].used must not exceed .max` };
            }
            slots[lvl] = { max: sMax, used: sUsed };
          }
          seedEntry.spell_slots = slots;
        }

        seed.push(seedEntry);
      }
      return {
        ok: true,
        value: { type: 'campaign_initialized', payload: { characters: seed } },
      };
    }

    // -----------------------------------------------------------------------
    // Phase 03 additions — see COMPLETENESS-AUDIT.md §"(c) Detailed event-type
    // specifications" for the authoritative payload + validator rules. Each
    // arm mirrors the audit row 1:1.
    // -----------------------------------------------------------------------

    case 'temp_hp_set': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'temp_hp_set requires {character: non-empty string, tempHp: integer in [0, 1000)}' };
      }
      if (
        typeof p.tempHp !== 'number' ||
        !Number.isInteger(p.tempHp) ||
        p.tempHp < 0 ||
        p.tempHp >= 1000
      ) {
        return { ok: false, error: 'temp_hp_set requires {character: non-empty string, tempHp: integer in [0, 1000)}' };
      }
      return {
        ok: true,
        value: { type: 'temp_hp_set', payload: { character: p.character, tempHp: p.tempHp } },
      };
    }

    case 'death_save_success': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_success requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'death_save_success', payload: { character: p.character } },
      };
    }

    case 'death_save_fail': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_fail requires {character: non-empty string, critical?: boolean}' };
      }
      const critical = p.critical;
      if (critical !== undefined && typeof critical !== 'boolean') {
        return { ok: false, error: 'death_save_fail.critical must be a boolean when provided' };
      }
      return {
        ok: true,
        value: {
          type: 'death_save_fail',
          payload: {
            character: p.character,
            ...(critical !== undefined ? { critical } : {}),
          },
        },
      };
    }

    case 'death_save_stabilize': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_stabilize requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'death_save_stabilize', payload: { character: p.character } },
      };
    }

    case 'death_save_recover_at_one': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_recover_at_one requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'death_save_recover_at_one', payload: { character: p.character } },
      };
    }

    case 'concentration_set': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'concentration_set requires {character: non-empty string, spellSlug: non-empty string, slotLevel: integer in [0, 9], startedRound: non-negative integer}' };
      }
      if (typeof p.spellSlug !== 'string' || p.spellSlug.length === 0) {
        return { ok: false, error: 'concentration_set requires {character: non-empty string, spellSlug: non-empty string, slotLevel: integer in [0, 9], startedRound: non-negative integer}' };
      }
      if (
        typeof p.slotLevel !== 'number' ||
        !Number.isInteger(p.slotLevel) ||
        p.slotLevel < 0 ||
        p.slotLevel > 9
      ) {
        return { ok: false, error: 'concentration_set requires {character: non-empty string, spellSlug: non-empty string, slotLevel: integer in [0, 9], startedRound: non-negative integer}' };
      }
      if (
        typeof p.startedRound !== 'number' ||
        !Number.isInteger(p.startedRound) ||
        p.startedRound < 0
      ) {
        return { ok: false, error: 'concentration_set requires {character: non-empty string, spellSlug: non-empty string, slotLevel: integer in [0, 9], startedRound: non-negative integer}' };
      }
      return {
        ok: true,
        value: {
          type: 'concentration_set',
          payload: {
            character: p.character,
            spellSlug: p.spellSlug,
            slotLevel: p.slotLevel,
            startedRound: p.startedRound,
          },
        },
      };
    }

    case 'concentration_break': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: "concentration_break requires {character: non-empty string, reason: 'damage' | 'killed' | 'incapacitated'}" };
      }
      if (
        p.reason !== 'damage' &&
        p.reason !== 'killed' &&
        p.reason !== 'incapacitated'
      ) {
        return { ok: false, error: "concentration_break requires {character: non-empty string, reason: 'damage' | 'killed' | 'incapacitated'}" };
      }
      return {
        ok: true,
        value: {
          type: 'concentration_break',
          payload: { character: p.character, reason: p.reason },
        },
      };
    }

    case 'exhaustion_increment': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'exhaustion_increment requires {character: non-empty string, source: non-empty string}' };
      }
      if (typeof p.source !== 'string' || p.source.length === 0) {
        return { ok: false, error: 'exhaustion_increment requires {character: non-empty string, source: non-empty string}' };
      }
      return {
        ok: true,
        value: {
          type: 'exhaustion_increment',
          payload: { character: p.character, source: p.source },
        },
      };
    }

    case 'exhaustion_decrement': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'exhaustion_decrement requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'exhaustion_decrement', payload: { character: p.character } },
      };
    }

    case 'hit_dice_use': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'hit_dice_use requires {character: non-empty string, count: integer in [1, 20]}' };
      }
      if (
        typeof p.count !== 'number' ||
        !Number.isInteger(p.count) ||
        p.count <= 0 ||
        p.count > 20
      ) {
        return { ok: false, error: 'hit_dice_use requires {character: non-empty string, count: integer in [1, 20]}' };
      }
      return {
        ok: true,
        value: { type: 'hit_dice_use', payload: { character: p.character, count: p.count } },
      };
    }

    case 'hit_dice_restore': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'hit_dice_restore requires {character: non-empty string, count: integer in [1, 20]}' };
      }
      if (
        typeof p.count !== 'number' ||
        !Number.isInteger(p.count) ||
        p.count <= 0 ||
        p.count > 20
      ) {
        return { ok: false, error: 'hit_dice_restore requires {character: non-empty string, count: integer in [1, 20]}' };
      }
      return {
        ok: true,
        value: { type: 'hit_dice_restore', payload: { character: p.character, count: p.count } },
      };
    }

    case 'resource_use': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'resource_use requires {character: non-empty string, resourceKey: non-empty string, uses: integer in [1, 50]}' };
      }
      if (typeof p.resourceKey !== 'string' || p.resourceKey.length === 0) {
        return { ok: false, error: 'resource_use requires {character: non-empty string, resourceKey: non-empty string, uses: integer in [1, 50]}' };
      }
      if (
        typeof p.uses !== 'number' ||
        !Number.isInteger(p.uses) ||
        p.uses <= 0 ||
        p.uses > 50
      ) {
        return { ok: false, error: 'resource_use requires {character: non-empty string, resourceKey: non-empty string, uses: integer in [1, 50]}' };
      }
      return {
        ok: true,
        value: {
          type: 'resource_use',
          payload: { character: p.character, resourceKey: p.resourceKey, uses: p.uses },
        },
      };
    }

    case 'resource_restore': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'resource_restore requires {character: non-empty string, resourceKey: non-empty string, uses: integer in [1, 50]}' };
      }
      if (typeof p.resourceKey !== 'string' || p.resourceKey.length === 0) {
        return { ok: false, error: 'resource_restore requires {character: non-empty string, resourceKey: non-empty string, uses: integer in [1, 50]}' };
      }
      if (
        typeof p.uses !== 'number' ||
        !Number.isInteger(p.uses) ||
        p.uses <= 0 ||
        p.uses > 50
      ) {
        return { ok: false, error: 'resource_restore requires {character: non-empty string, resourceKey: non-empty string, uses: integer in [1, 50]}' };
      }
      return {
        ok: true,
        value: {
          type: 'resource_restore',
          payload: { character: p.character, resourceKey: p.resourceKey, uses: p.uses },
        },
      };
    }

    case 'inspiration_grant': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'inspiration_grant requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'inspiration_grant', payload: { character: p.character } },
      };
    }

    case 'inspiration_spend': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'inspiration_spend requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'inspiration_spend', payload: { character: p.character } },
      };
    }

    case 'attune': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'attune requires {character: non-empty string, itemSlug: non-empty string of length <= 64}' };
      }
      if (
        typeof p.itemSlug !== 'string' ||
        p.itemSlug.length === 0 ||
        p.itemSlug.length > 64
      ) {
        return { ok: false, error: 'attune requires {character: non-empty string, itemSlug: non-empty string of length <= 64}' };
      }
      return {
        ok: true,
        value: { type: 'attune', payload: { character: p.character, itemSlug: p.itemSlug } },
      };
    }

    case 'unattune': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'unattune requires {character: non-empty string, itemSlug: non-empty string of length <= 64}' };
      }
      if (
        typeof p.itemSlug !== 'string' ||
        p.itemSlug.length === 0 ||
        p.itemSlug.length > 64
      ) {
        return { ok: false, error: 'unattune requires {character: non-empty string, itemSlug: non-empty string of length <= 64}' };
      }
      return {
        ok: true,
        value: { type: 'unattune', payload: { character: p.character, itemSlug: p.itemSlug } },
      };
    }

    case 'focus_set': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: "focus_set requires {character: non-empty string, kind: 'arcane' | 'druidic' | 'holy' | 'instrument', itemSlug: non-empty string}" };
      }
      if (
        p.kind !== 'arcane' &&
        p.kind !== 'druidic' &&
        p.kind !== 'holy' &&
        p.kind !== 'instrument'
      ) {
        return { ok: false, error: "focus_set requires {character: non-empty string, kind: 'arcane' | 'druidic' | 'holy' | 'instrument', itemSlug: non-empty string}" };
      }
      if (typeof p.itemSlug !== 'string' || p.itemSlug.length === 0) {
        return { ok: false, error: "focus_set requires {character: non-empty string, kind: 'arcane' | 'druidic' | 'holy' | 'instrument', itemSlug: non-empty string}" };
      }
      return {
        ok: true,
        value: {
          type: 'focus_set',
          payload: { character: p.character, kind: p.kind, itemSlug: p.itemSlug },
        },
      };
    }

    case 'focus_unset': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'focus_unset requires {character: non-empty string}' };
      }
      return {
        ok: true,
        value: { type: 'focus_unset', payload: { character: p.character } },
      };
    }

    case 'xp_award': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'xp_award requires {character: non-empty string, amount: integer in (0, 1000000), reason?: string of length <= 256}' };
      }
      if (
        typeof p.amount !== 'number' ||
        !Number.isFinite(p.amount) ||
        !Number.isInteger(p.amount) ||
        p.amount <= 0 ||
        p.amount >= 1_000_000
      ) {
        return { ok: false, error: 'xp_award requires {character: non-empty string, amount: integer in (0, 1000000), reason?: string of length <= 256}' };
      }
      const reason = p.reason;
      if (reason !== undefined) {
        if (typeof reason !== 'string' || reason.length > 256) {
          return { ok: false, error: 'xp_award.reason must be a string of length <= 256 when provided' };
        }
      }
      return {
        ok: true,
        value: {
          type: 'xp_award',
          payload: {
            character: p.character,
            amount: p.amount,
            ...(typeof reason === 'string' ? { reason } : {}),
          },
        },
      };
    }

    default: {
      // Unreachable at runtime — `isVaultEventType` above already
      // narrowed `input.type` to `VaultEventType`. The `never` typing on
      // `_exhaustive` triggers a tsc error if a new union member is added
      // without a corresponding case arm (Pitfall 6 enforcement at the
      // validator level — the projector enforces it independently).
      const _exhaustive: never = input.type;
      return { ok: false, error: `unhandled event type: ${String(_exhaustive)}` };
    }
  }
}
