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
  'hp_change',
  'condition_add',
  'condition_remove',
  'spell_slot_use',
  'spell_slot_restore',
  'inventory_add',
  'inventory_remove',
  'campaign_initialized',
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
 * The projector's `INITIAL_CHARACTER_STATE` defaults:
 *   - `hp_current` absent → set to `hp_max`
 *   - `spell_slots` absent → set to `{}`
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
  | { type: 'hp_change'; payload: { character: string; delta: number } }
  | { type: 'condition_add'; payload: { character: string; condition: string } }
  | { type: 'condition_remove'; payload: { character: string; condition: string } }
  | { type: 'spell_slot_use'; payload: { character: string; level: number } }
  | { type: 'spell_slot_restore'; payload: { character: string; level: number } }
  | { type: 'inventory_add'; payload: { character: string; item: string; qty: number } }
  | { type: 'inventory_remove'; payload: { character: string; item: string; qty: number } }
  | { type: 'campaign_initialized'; payload: { characters: VaultSeedCharacter[] } };

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
