/**
 * Phase 02 — Event projector: pure reducer + materialized-view regenerator.
 *
 * REQ-004 — events.md is the source of truth; per-entity `.md` files under
 *           `characters/` are materialized projections. This module is the
 *           projection function: it consumes the append-only event log and
 *           produces deterministic state + a byte-stable markdown view file.
 * REQ-006 — DR procedure = replay events.md → regenerate views. This module
 *           ships the `replayEvents` + `regenerateCharacterView` primitives
 *           the Phase 02 `vault-rebuild-views` script (plan 02-10) and the
 *           apply_event dispatcher (plan 02-07) invoke.
 *
 * Design contract (locked):
 *
 *   1. Spike 008 (`.planning/spikes/008-events-md-replay/replay.ts`) is the
 *      source-of-truth implementation. The reducer pattern in
 *      `applyEvent` is a direct extension of the spike — same
 *      `structuredClone` immutability discipline, same `JSON.parse`
 *      fail-fast policy on corruption, same per-event-type switch.
 *
 *   2. RESEARCH §4 Pattern 2 — `applyEvent(state, event)` is PURE. No
 *      time-of-day reads, no randomness, no env-variable reads. The reducer
 *      MUST be a deterministic function: same `(state, event)` always
 *      yields the same `state'`. Side effects (timestamp generation,
 *      randomness, env reads) belong to the dispatcher (plan 02-07), not
 *      the projector. This is the same hygiene rule REQ-022 enforces for
 *      `prompt-builder.ts` and is checked at the test layer (the grep gate
 *      in plan 02-04 Task 1 acceptance criteria).
 *
 *   3. RESEARCH §4 Pattern 3 — `regenerateCharacterView` runs full replay
 *      from disk and rewrites the view file atomically. The view IS the
 *      projector's output; treat as read-only from everywhere else.
 *
 *   4. Decision 2 (synchronous regen) — `regenerateAffectedViews` is the
 *      hook the dispatcher calls synchronously after each `EventsWriter.append`.
 *      Spike 008 measured ~1 ms for 100 events; even a year-long campaign
 *      (~2K events) regenerates in ~20 ms which is negligible vs the
 *      LLM tool round-trip.
 *
 *   5. Decision 9 (campaign_initialized seed event) — the 8th event type
 *      is the synthetic seed emitted by `vault-flip` (plan 02-10). It
 *      populates `INITIAL_CHARACTER_STATE` for each character in the
 *      payload. Because the seed mirrors Postgres reality:
 *        - `hp_current` is OPTIONAL — when a campaign has no `session_state`
 *          row yet (freshly-created, never-played), the flip script omits
 *          it. The projector falls back to `hp_max` (PC starts at full HP).
 *        - `spell_slots` is OPTIONAL — when a PC has
 *          `characters.spellcasting: null` (non-caster), the flip script
 *          omits it. The projector falls back to `{}` (no slots).
 *      These fallbacks are LOCKED by the live Postgres schema; do NOT
 *      tighten them without re-spiking.
 *
 *   6. Pitfall 6 (graceful degradation) — the reducer's `default:` arm
 *      uses TypeScript's `never` type for compile-time exhaustiveness
 *      AND logs unknown event types at runtime. A future Phase 03+ event
 *      type appearing in an older deployment's events.md MUST not throw —
 *      replay continues with possibly-stale state, and a single warning
 *      surfaces the drift to the operator.
 *
 *   7. Spike 013 (DR byte-exact restore) — `serializeView` produces a
 *      byte-stable output for the same input state. Deterministic key
 *      ordering (alphabetical sort on `conditions`, `inventory.item`,
 *      `spell_slots` keys) is mandatory: the DR test corrupts a view,
 *      re-runs replay+serialize, and asserts byte-for-byte equality with
 *      the pre-corruption file.
 *
 *   8. The projector's per-character state lives in a `Map<characterId,
 *      CharacterState>` during replay. Lookup is by character UUID (the
 *      `payload.character` field on the 7 mutation events). The slug+id8
 *      is the on-disk filename convention; the LLM addresses characters
 *      by UUID throughout the tool surface.
 *
 * Test seam: `parseView(serializeView(state)) === state` is a Vitest-only
 * round-trip property check. Production code reads views via the LLM's
 * `read_vault_multi` tool only — never via `parseView`. The seam exists
 * so the must_have "Round-trip property" stays asserted in regression.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  VaultEvent,
  VaultEventEnvelope,
  VaultSeedCharacter,
} from './events-schema';
import { ENCOUNTER_EVENT_TYPES } from './events-schema';
import { eventsPath, characterViewPath, campaignDir } from './campaign-paths';

/**
 * Materialized per-character state derived from replaying the events.md
 * append-only log. The shape mirrors spike 008's `CharacterState` with
 * three additions Phase 02 makes explicit:
 *
 *   - `id` — character UUID, used as the key in the replay state Map and
 *           as the `-<id8>` suffix in the on-disk filename.
 *   - `inventory` — array of `{item, qty}` aggregated by item name (not
 *                  in spike 008 because the spike's payload set was
 *                  hp/conditions/slots only; Phase 02 ships the full 7
 *                  mutation event types).
 *   - `last_event_id` / `last_updated` — metadata from the most-recent
 *                                       event's envelope. Optional because
 *                                       `INITIAL_CHARACTER_STATE` (from a
 *                                       campaign_initialized seed) has no
 *                                       preceding event. Re-replay
 *                                       produces identical state regardless
 *                                       of these fields — they help
 *                                       debugging + give the LLM a
 *                                       freshness signal.
 *
 * Phase 03 additions (plan 03-A-03 — COMPLETENESS-AUDIT.md (c) list):
 *   - `temp_hp`            — session_state.temp_hp absorbing damage layer
 *   - `death_saves`        — successes/failures counter (PHB §3.18)
 *   - `flags`              — `{stable, dead, inspiration}` merged session+char flags
 *   - `concentrating_on`   — spell concentration slot (PHB §10.4); null when none
 *   - `exhaustion_level`   — stacking counter 0..6 (PHB §4.1)
 *   - `hit_dice_remaining` / `hit_dice_max` — short-rest pool (PHB §5.1)
 *   - `attunements`        — magic-item attuned slugs (PHB §10.1)
 *   - `equipped_focus`     — currently equipped spellcasting focus (PHB §8.4)
 *   - `resources_used`     — per-feature counter (rage, action surge, etc.)
 *   - `xp`                 — characters.xp
 *   - `level`              — characters.level
 *
 * Field ordering policy: Phase 02 fields keep their original positions for
 * historical readability; Phase 03 fields appended at the end of the
 * interface declaration. Serialization (`serializeView`) writes Phase 02
 * keys first, Phase 03 keys after — preserving byte-stability with
 * existing on-disk views that lack Phase 03 keys (parseView defaults
 * missing keys to the same values `INITIAL_CHARACTER_STATE` uses, so old
 * views still round-trip).
 */
export interface CharacterState {
  id: string;
  name: string;
  hp_current: number;
  hp_max: number;
  conditions: string[];
  spell_slots: Record<string, { max: number; used: number }>;
  inventory: { item: string; qty: number }[];
  // Phase 03 additions
  temp_hp: number;
  death_saves: { successes: number; failures: number };
  flags: { stable: boolean; dead: boolean; inspiration: boolean };
  concentrating_on: { spellSlug: string; slotLevel: number; startedRound: number } | null;
  exhaustion_level: number;
  hit_dice_remaining: number;
  hit_dice_max: number;
  attunements: string[];
  equipped_focus: { kind: 'arcane' | 'druidic' | 'holy' | 'instrument'; itemSlug: string } | null;
  resources_used: Record<string, number>;
  xp: number;
  level: number;
  last_event_id?: string;
  last_updated?: string;
}

/**
 * Factory: build an INITIAL_CHARACTER_STATE from a `VaultSeedCharacter`
 * entry inside a `campaign_initialized` event payload.
 *
 * Postgres-reality fallbacks (Decision 9 — LOCKED, Phase 02 baseline):
 *   - `seed.hp_current` is OPTIONAL — when absent (no `session_state` row
 *     for the most-recent active session), default to `seed.hp_max` so a
 *     freshly-created campaign starts at full HP.
 *   - `seed.spell_slots` is OPTIONAL — when absent (the PC has
 *     `characters.spellcasting: null` — non-caster), default to `{}` so
 *     no slot-related operations crash on a missing record.
 *
 * Phase 03 fallback policy (plan 03-A-03): every new field is OPTIONAL on
 * the seed and falls back to a neutral default that matches the Postgres
 * column default. This preserves backward compatibility — seeds emitted
 * by the Phase 02 `vault-flip` (which knows nothing about the Phase 03
 * fields) still produce a valid Phase 03 `CharacterState` with zero risk
 * of `undefined` propagating into the reducer.
 *
 * The returned state has empty `conditions: []` and `inventory: []`
 * unconditionally — the seed event does not carry these fields; they are
 * populated only by subsequent mutation events.
 */
export function INITIAL_CHARACTER_STATE(seed: VaultSeedCharacter): CharacterState {
  return {
    id: seed.id,
    name: seed.name,
    // Postgres-reality fallback: session_state.hpCurrent may not exist on
    // a freshly-created campaign — see VaultSeedCharacter JSDoc.
    hp_current: seed.hp_current ?? seed.hp_max,
    hp_max: seed.hp_max,
    conditions: [],
    // Postgres-reality fallback: characters.spellcasting may be null for
    // non-caster PCs — see VaultSeedCharacter JSDoc.
    spell_slots: seed.spell_slots ?? {},
    inventory: [],
    // Phase 03 defaults — all match the Postgres column defaults so a
    // brand-new campaign (no Phase 03 seed extension) seeds identically
    // to what the parity-check expects for never-mutated PCs.
    temp_hp: seed.temp_hp ?? 0,
    death_saves: seed.death_saves ?? { successes: 0, failures: 0 },
    flags: {
      stable: seed.flags?.stable ?? false,
      dead: seed.flags?.dead ?? false,
      inspiration: seed.flags?.inspiration ?? false,
    },
    concentrating_on: seed.concentrating_on ?? null,
    exhaustion_level: seed.exhaustion_level ?? 0,
    hit_dice_remaining: seed.hit_dice_remaining ?? 0,
    hit_dice_max: seed.hit_dice_max ?? 0,
    attunements: seed.attunements ? [...seed.attunements].sort() : [],
    equipped_focus: seed.equipped_focus ?? null,
    resources_used: seed.resources_used ?? {},
    xp: seed.xp ?? 0,
    level: seed.level ?? 1,
  };
}

/**
 * PURE reducer over the `VaultEvent` discriminated union.
 *
 * Determinism contract (RESEARCH §4 Pattern 2):
 *   - No clock reads, no randomness, no environment reads.
 *   - `structuredClone(state)` is the first statement: the returned state
 *     is a fresh object, the input is never mutated.
 *   - Same `(state, event)` input always yields a deeply-equal output.
 *
 * Per-event-type semantics:
 *
 *   PHASE 02 (unchanged):
 *
 *   - `hp_change` — clamp `state.hp_current + delta` to `[0, state.hp_max]`.
 *                  T-02-03 mitigation: even a hostile `delta: -999999`
 *                  bottoms out at 0 (no negative HP); a hostile
 *                  `delta: +999999` tops out at `hp_max` (no over-heal).
 *   - `condition_add` — append condition iff absent; sort the array after
 *                      mutation so the on-disk view is byte-stable (DR
 *                      invariant from spike 013).
 *   - `condition_remove` — filter out the condition (no-op if absent).
 *   - `spell_slot_use` — `slot.used += 1` iff a slot exists at that level
 *                       AND `used < max`. Missing slot key (e.g., LLM
 *                       targets a level the seed did not declare) is a
 *                       graceful no-op.
 *   - `spell_slot_restore` — `slot.used -= 1` iff a slot exists at that
 *                           level AND `used > 0`.
 *   - `inventory_add` — add to existing item's qty OR push a new entry;
 *                      sort the array by `item.localeCompare` after
 *                      mutation (DR byte-stability).
 *   - `inventory_remove` — decrement qty (clamped to 0); when qty reaches
 *                         0 the entry is spliced out. Removal of a
 *                         non-existent item is a graceful no-op.
 *   - `campaign_initialized` — no-op at the reducer level. The seed event
 *                             populates the state Map BEFORE reducer
 *                             dispatch (see `replayEvents`); applying it
 *                             again to an existing state is meaningless.
 *
 *   PHASE 03 ADDITIONS (plan 03-A-03 — see COMPLETENESS-AUDIT.md (c) list):
 *
 *   - `temp_hp_set`             — overwrite `temp_hp` (clamped to ≥ 0).
 *   - `death_save_success`      — increment successes; at 3 → reset to
 *                                 {0,0}, set flags.stable, ensure
 *                                 `unconscious` in conditions (per PHB §3.18
 *                                 mirror of applicator.ts:574-589).
 *   - `death_save_fail`         — increment failures by 1 (or 2 if
 *                                 `critical`); at 3 → set flags.dead and
 *                                 leave death_saves at {0, 3} (preserved
 *                                 for traceability — applicator.ts:601-608).
 *   - `death_save_stabilize`    — reset death_saves to {0,0}, set
 *                                 flags.stable. Does NOT touch `conditions`
 *                                 (PHB §3.19: stable but still unconscious).
 *   - `death_save_recover_at_one` — PHB §3.18 nat-20 atomic recovery:
 *                                 reset death_saves, hp_current = 1, remove
 *                                 `unconscious` condition, clear stable/dead.
 *   - `concentration_set`       — overwrite `concentrating_on`.
 *   - `concentration_break`     — `concentrating_on = null` (reducer ignores
 *                                 `reason` — it's metadata for audit/log).
 *   - `exhaustion_increment`    — clamp +1 to [0, 6]; at 6 → flags.dead.
 *                                 Append `exhaustion` to conditions iff
 *                                 absent (idempotent — exhaustion appears
 *                                 once; the level tracks intensity).
 *   - `exhaustion_decrement`    — clamp -1 to [0, 6]; at 0 → remove
 *                                 `exhaustion` from conditions.
 *   - `hit_dice_use`            — `max(0, remaining - count)`.
 *   - `hit_dice_restore`        — `min(hit_dice_max, remaining + count)`.
 *   - `resource_use`            — `resources_used[key] = (cur ?? 0) + uses`.
 *   - `resource_restore`        — decrement uses, delete key when reaches 0.
 *   - `inspiration_grant`       — `flags.inspiration = true`.
 *   - `inspiration_spend`       — `flags.inspiration = false`.
 *   - `attune`                  — append slug iff absent, sort (DR
 *                                 byte-stability, same idiom as conditions).
 *   - `unattune`                — filter out slug (no-op if absent).
 *   - `focus_set`               — overwrite `equipped_focus`.
 *   - `focus_unset`             — `equipped_focus = null`.
 *   - `xp_award`                — `xp += amount` (validator already bounds
 *                                 `amount` to integer in (0, 1_000_000)).
 *
 *   Every Phase 03 arm guards on `event.payload.character !== state.id` and
 *   returns the cloned state unchanged in that case — the reducer is
 *   called per-character with a single state; events for OTHER characters
 *   in the same campaign are no-ops at this layer. (`replayEvents` already
 *   routes events to the correct state by UUID, so this guard is defensive
 *   against a manually-corrupted events.md that mis-targets a character.)
 *
 * The `default:` arm holds a `never`-typed exhaustiveness sentinel — if a new
 * `VaultEvent` union member is added without a corresponding `case`,
 * `tsc` errors at compile time (Decision 1's type-system-enforced
 * contract). At runtime, the warning + state-unchanged path is Pitfall 6's
 * graceful degradation for forward-compatibility across phases.
 */
export function applyEvent(state: CharacterState, event: VaultEvent): CharacterState {
  const next = structuredClone(state);
  switch (event.type) {
    case 'hp_change':
      next.hp_current = Math.max(
        0,
        Math.min(state.hp_max, state.hp_current + event.payload.delta),
      );
      return next;

    case 'condition_add':
      if (!next.conditions.includes(event.payload.condition)) {
        next.conditions.push(event.payload.condition);
        // Deterministic ordering for byte-stable view output (spike 013
        // DR invariant — corrupted view + replay must reproduce the
        // original bytes).
        next.conditions.sort();
      }
      return next;

    case 'condition_remove':
      next.conditions = next.conditions.filter((c) => c !== event.payload.condition);
      return next;

    case 'spell_slot_use': {
      const key = String(event.payload.level);
      const slot = next.spell_slots[key];
      if (slot && slot.used < slot.max) {
        slot.used += 1;
      }
      // Missing slot key OR already at max: graceful no-op. Defends
      // against the seed event omitting a level the LLM later targets,
      // and against double-use at the cap.
      return next;
    }

    case 'spell_slot_restore': {
      const key = String(event.payload.level);
      const slot = next.spell_slots[key];
      if (slot && slot.used > 0) {
        slot.used -= 1;
      }
      return next;
    }

    case 'inventory_add': {
      const existing = next.inventory.find((i) => i.item === event.payload.item);
      if (existing) {
        existing.qty += event.payload.qty;
      } else {
        next.inventory.push({ item: event.payload.item, qty: event.payload.qty });
      }
      // Deterministic ordering — same DR invariant as `conditions`.
      next.inventory.sort((a, b) => a.item.localeCompare(b.item));
      return next;
    }

    case 'inventory_remove': {
      const idx = next.inventory.findIndex((i) => i.item === event.payload.item);
      if (idx === -1) return next; // Graceful no-op on non-existent item.
      // `noUncheckedIndexedAccess` makes the indexed read possibly-undefined;
      // we just located `idx` via `findIndex`, so the entry exists. Use a
      // local reference to satisfy the strict-null-check.
      const entry = next.inventory[idx]!;
      entry.qty = Math.max(0, entry.qty - event.payload.qty);
      if (entry.qty === 0) {
        next.inventory.splice(idx, 1);
      }
      return next;
    }

    case 'campaign_initialized':
      // Seed events are handled by `replayEvents` (state-map setup
      // BEFORE reducer dispatch). Applying a seed event to an existing
      // state is meaningless — return the cloned state untouched.
      return next;

    // ---------------------------------------------------------------------
    // Phase 03 arms — see COMPLETENESS-AUDIT.md §"(c) Detailed event-type
    // specifications" for the authoritative spec. Every arm mirrors the
    // applicator's `applyOne` mutation semantics for the matching `op` so
    // dual-write parity holds at replay time.
    //
    // Cross-character guard: every Phase 03 arm checks
    // `event.payload.character === state.id` — if the event targets another
    // character, return the cloned state unchanged. `replayEvents`
    // pre-routes events by UUID, so the guard is defensive against
    // operator-edited events.md.
    // ---------------------------------------------------------------------

    case 'temp_hp_set': {
      if (event.payload.character !== state.id) return next;
      next.temp_hp = Math.max(0, event.payload.tempHp);
      return next;
    }

    case 'death_save_success': {
      if (event.payload.character !== state.id) return next;
      const successes = state.death_saves.successes + 1;
      if (successes >= 3) {
        // PHB §3.18 — 3 successes ⇒ stable. Reset the counter; set
        // `flags.stable`; ensure `unconscious` stays in conditions
        // (matches applicator.ts:574-589 — stabilizing does NOT wake
        // the PC, it only halts the dying clock).
        next.death_saves = { successes: 0, failures: 0 };
        next.flags = { ...next.flags, stable: true };
        if (!next.conditions.includes('unconscious')) {
          next.conditions.push('unconscious');
          next.conditions.sort();
        }
        return next;
      }
      next.death_saves = { successes, failures: state.death_saves.failures };
      return next;
    }

    case 'death_save_fail': {
      if (event.payload.character !== state.id) return next;
      const incrementBy = event.payload.critical ? 2 : 1;
      const failures = Math.min(3, state.death_saves.failures + incrementBy);
      if (failures >= 3) {
        // PHB §3.18 — 3 failures ⇒ dead. Preserve `failures: 3` in the
        // record for traceability (applicator.ts:601-608) — diagnostic
        // information for the operator audit trail.
        next.death_saves = { successes: 0, failures: 3 };
        next.flags = { ...next.flags, dead: true };
        return next;
      }
      next.death_saves = { successes: state.death_saves.successes, failures };
      return next;
    }

    case 'death_save_stabilize': {
      if (event.payload.character !== state.id) return next;
      next.death_saves = { successes: 0, failures: 0 };
      next.flags = { ...next.flags, stable: true };
      // PHB §3.19: stabilized but still unconscious — DO NOT modify
      // `conditions` here. The PC remains unconscious until healed or
      // until the natural 1-HP recovery from the nat-20 death-save case.
      return next;
    }

    case 'death_save_recover_at_one': {
      if (event.payload.character !== state.id) return next;
      // PHB §3.18 nat-20 atomic recovery: reset all death-save state,
      // restore 1 HP, drop unconscious. Single event so replay never
      // observes an intermediate state where (e.g.) HP=1 but the PC is
      // still marked dead (which would be a one-step-too-old snapshot).
      next.death_saves = { successes: 0, failures: 0 };
      next.hp_current = 1;
      next.conditions = next.conditions.filter((c) => c !== 'unconscious');
      next.flags = { ...next.flags, stable: false, dead: false };
      return next;
    }

    case 'concentration_set': {
      if (event.payload.character !== state.id) return next;
      next.concentrating_on = {
        spellSlug: event.payload.spellSlug,
        slotLevel: event.payload.slotLevel,
        startedRound: event.payload.startedRound,
      };
      return next;
    }

    case 'concentration_break': {
      if (event.payload.character !== state.id) return next;
      // The validator already accepted `reason` ('damage' | 'killed' |
      // 'incapacitated'). The reducer ignores it — `reason` is operator
      // audit metadata, not part of the reducible state. (Recoverable
      // from the events.md log when needed.)
      next.concentrating_on = null;
      return next;
    }

    case 'exhaustion_increment': {
      if (event.payload.character !== state.id) return next;
      // PHB §4.1 caps exhaustion at level 6. The applicator marks the PC
      // dead on reaching 6 (applicator.ts:217) — mirror that side effect
      // here so post-replay flags.dead correctly reflects the cumulative
      // exhaustion damage.
      next.exhaustion_level = Math.min(6, state.exhaustion_level + 1);
      if (next.exhaustion_level >= 6) {
        next.flags = { ...next.flags, dead: true };
      }
      // The `exhaustion` condition string is appended ONCE (idempotent).
      // The level integer (not the array entry count) tracks intensity —
      // matches the applicator's unique handling for exhaustion stacking.
      if (!next.conditions.includes('exhaustion')) {
        next.conditions.push('exhaustion');
        next.conditions.sort();
      }
      return next;
    }

    case 'exhaustion_decrement': {
      if (event.payload.character !== state.id) return next;
      if (state.exhaustion_level <= 0) return next;
      next.exhaustion_level = state.exhaustion_level - 1;
      if (next.exhaustion_level === 0) {
        // Reaching level 0 removes the `exhaustion` array entry to keep
        // `conditions` semantically clean.
        next.conditions = next.conditions.filter((c) => c !== 'exhaustion');
      }
      return next;
    }

    case 'hit_dice_use': {
      if (event.payload.character !== state.id) return next;
      next.hit_dice_remaining = Math.max(
        0,
        state.hit_dice_remaining - event.payload.count,
      );
      return next;
    }

    case 'hit_dice_restore': {
      if (event.payload.character !== state.id) return next;
      next.hit_dice_remaining = Math.min(
        state.hit_dice_max,
        state.hit_dice_remaining + event.payload.count,
      );
      return next;
    }

    case 'resource_use': {
      if (event.payload.character !== state.id) return next;
      const cur = state.resources_used[event.payload.resourceKey] ?? 0;
      next.resources_used = {
        ...state.resources_used,
        [event.payload.resourceKey]: cur + event.payload.uses,
      };
      return next;
    }

    case 'resource_restore': {
      if (event.payload.character !== state.id) return next;
      const cur = state.resources_used[event.payload.resourceKey] ?? 0;
      const remaining = Math.max(0, cur - event.payload.uses);
      const cloned = { ...state.resources_used };
      if (remaining === 0) {
        delete cloned[event.payload.resourceKey];
      } else {
        cloned[event.payload.resourceKey] = remaining;
      }
      next.resources_used = cloned;
      return next;
    }

    case 'inspiration_grant': {
      if (event.payload.character !== state.id) return next;
      next.flags = { ...next.flags, inspiration: true };
      return next;
    }

    case 'inspiration_spend': {
      if (event.payload.character !== state.id) return next;
      next.flags = { ...next.flags, inspiration: false };
      return next;
    }

    case 'attune': {
      if (event.payload.character !== state.id) return next;
      if (next.attunements.includes(event.payload.itemSlug)) return next;
      next.attunements.push(event.payload.itemSlug);
      // Sort for byte-stable view (spike 013 DR invariant — same idiom
      // as the `conditions` reducer arm).
      next.attunements.sort();
      return next;
    }

    case 'unattune': {
      if (event.payload.character !== state.id) return next;
      next.attunements = next.attunements.filter((s) => s !== event.payload.itemSlug);
      return next;
    }

    case 'focus_set': {
      if (event.payload.character !== state.id) return next;
      next.equipped_focus = {
        kind: event.payload.kind,
        itemSlug: event.payload.itemSlug,
      };
      return next;
    }

    case 'focus_unset': {
      if (event.payload.character !== state.id) return next;
      next.equipped_focus = null;
      return next;
    }

    case 'xp_award': {
      if (event.payload.character !== state.id) return next;
      // Validator (events-schema.ts) already bounds `amount` to a
      // positive integer < 1_000_000; no defensive clamp needed.
      next.xp = state.xp + event.payload.amount;
      return next;
    }

    // -----------------------------------------------------------------------
    // Phase 06 (D1 — encounter-scoped) no-ops for the per-character reducer.
    // Encounter events have no `payload.character` field; they are consumed
    // by `applyEncounterEvent` (below) in a separate reducer pass. The
    // per-character reducer sees these events only if they somehow pass
    // through the character-event routing in `replayEvents`, which should
    // not happen — but the case arms are required for tsc exhaustiveness.
    // -----------------------------------------------------------------------
    case 'combat_start':
    case 'monster_spawn':
    case 'initiative_set':
    case 'turn_advance':
    case 'monster_hp_change':
    case 'combat_end':
      // Encounter-scoped events — no per-character state change. Return the
      // cloned state unchanged (structuredClone already applied at top of fn).
      return next;

    default: {
      // Compile-time exhaustiveness check (Decision 1). Adding a new
      // member to the `VaultEvent` union without a corresponding `case`
      // arm makes the sentinel below fail tsc, surfacing the gap before
      // it ships.
      //
      // Runtime: graceful degradation (Pitfall 6). When events.md carries
      // an event type from a newer schema version that this code does
      // not know about, log + return state unchanged so replay can
      // complete with possibly-stale state instead of crashing.
      const _exhaustive: never = event;
      console.warn('[projector] unknown event type, state unchanged:', _exhaustive);
      return next;
    }
  }
}

/**
 * Materialized encounter state derived from replaying the encounter-scoped
 * events in an events.md log (Phase 06 D1).
 *
 * Shape is LOCKED by 06-CONTEXT.md §"EncounterState + view (LOCKED)":
 *   - `active`      — true while combat is running
 *   - `round`       — current combat round (starts at 1 on combat_start)
 *   - `currentIdx`  — index into `turnOrder` pointing at the active actor
 *   - `turnOrder`   — ordered list of {actorId, initiative} pairs; PC UUIDs
 *                     and monster IDs are mixed here. Set by initiative_set.
 *   - `monsters`    — encounter-scoped monster states (PCs are tracked in the
 *                     existing per-character CharacterState map; only monsters
 *                     live here as they have no separate vault character file).
 *
 * Design invariants:
 *   - Only monsters live in `EncounterState.monsters`. PC HP comes from the
 *     per-character CharacterState (unchanged by this phase).
 *   - `conditions` on a monster defaults to `[]`; Phase 06 D1 does not add
 *     in-combat conditions (that is D3). The field exists for forward-compat.
 *   - `ac` and `initiativeBonus` are optional — many basic monsters specify
 *     only HP (the minimum needed to render HP bars in the CombatTracker).
 */
export interface EncounterState {
  active: boolean;
  round: number;
  currentIdx: number;
  turnOrder: Array<{ actorId: string; initiative: number }>;
  monsters: Array<{
    id: string;
    name: string;
    hpCurrent: number;
    hpMax: number;
    ac?: number;
    initiativeBonus?: number;
    // D-08: optional difficulty hint sourced ONLY from the server-controlled
    // monster_spawn event; the resolver reads it at attack time (CR table).
    cr?: number;
    isAlive: boolean;
    conditions: string[];
  }>;
}

/**
 * The inert initial encounter state — no combat running, no monsters.
 * Used as the starting point for `replayEncounterEvents` before any
 * combat events have been applied.
 */
export const INITIAL_ENCOUNTER_STATE: EncounterState = {
  active: false,
  round: 0,
  currentIdx: 0,
  turnOrder: [],
  monsters: [],
};

/**
 * Deterministic unique-name deduplication for EncounterState.monsters (Phase 08-02).
 *
 * When ≥2 monsters share the same base name, ALL of them are numbered in
 * encounter order: "Pirata di Buggy 1", "Pirata di Buggy 2", "Pirata di Buggy 3".
 * The FIRST collider is also numbered — never "Base", "Base 2", "Base 3".
 * A lone monster with a unique base name stays unnumbered.
 *
 * Ids are left untouched — only the `name` field is modified.
 * Pure: returns a structuredClone of `state` with updated names; never mutates input.
 *
 * IDEMPOTENT / INCREMENTAL: the function first strips any previously-appended
 * numeric suffix (` N`) to recover the original base name, then renumbers the
 * full monsters array from scratch. This makes it safe to call after every
 * monster_spawn without accumulating double-suffixes (e.g. spawn 1→ "X 1",
 * spawn 2 → "X 1", "X 2"; spawn 3 → "X 1", "X 2", "X 3").
 *
 * Called from the `monster_spawn` reducer so that every replay produces
 * deterministically unique names in `EncounterState.monsters`.
 */
export function deduplicateMonsterNames(state: EncounterState): EncounterState {
  const result = structuredClone(state);

  // Step 1: extract base names by stripping a trailing " N" suffix that may
  // have been appended by a previous call (idempotency / incremental spawns).
  const NUMERIC_SUFFIX = / \d+$/;
  const baseNames: string[] = result.monsters.map((m) =>
    NUMERIC_SUFFIX.test(m.name) ? m.name.replace(NUMERIC_SUFFIX, '') : m.name,
  );

  // Step 2: count occurrences of each base name.
  const counts = new Map<string, number>();
  for (const base of baseNames) {
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  // Step 3: assign sequential numbers only to names with ≥2 occurrences.
  const seen = new Map<string, number>();
  for (let i = 0; i < result.monsters.length; i++) {
    const base = baseNames[i]!;
    if ((counts.get(base) ?? 0) >= 2) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      result.monsters[i]!.name = `${base} ${n}`;
    } else {
      // Unique base name — ensure any stale suffix from a prior state is removed.
      result.monsters[i]!.name = base;
    }
  }
  return result;
}

/**
 * PURE reducer over the 6 encounter-scoped event types (Phase 06 D1).
 *
 * Determinism contract (same as `applyEvent`):
 *   - No clock reads, no randomness, no environment reads.
 *   - `structuredClone(state)` is the first statement.
 *   - Same `(state, event)` input always yields a deeply-equal output.
 *
 * Reducer effects per CONTEXT §"Event schema (LOCKED)":
 *
 *   - combat_start          → re-init: active=true, round=1, currentIdx=0,
 *                             turnOrder=[], monsters=[]
 *   - monster_spawn         → if !active, AUTO-ACTIVATE (fresh active encounter)
 *                             then append (robustness: models skip combat_start);
 *                             if duplicate id skip; append {id,name,
 *                             hpCurrent:hpMax,hpMax,ac?,initiativeBonus?,
 *                             isAlive:true,conditions:[]}
 *   - initiative_set        → if !active, AUTO-ACTIVATE; turnOrder=order, currentIdx=0
 *   - turn_advance          → if !active skip; if turnOrder empty skip;
 *                             newIdx = currentIdx+1;
 *                             if newIdx >= turnOrder.length: currentIdx=0, round++
 *                             else: currentIdx=newIdx
 *   - monster_hp_change     → if !active skip; find monster by id;
 *                             if not found skip (defensive);
 *                             newHp = max(0, hpCurrent+delta);
 *                             isAlive = newHp > 0
 *   - combat_end            → active=false
 *
 * The `default:` arm returns state unchanged — NOT `never`-typed — because
 * this reducer only handles the 6 encounter event types; it is intentionally
 * NOT exhaustive over all VaultEvent members.
 */
export function applyEncounterEvent(state: EncounterState, event: VaultEvent): EncounterState {
  const next = structuredClone(state);
  switch (event.type) {
    case 'combat_start':
      // Re-initialize: fresh encounter state, discards any prior encounter.
      return { active: true, round: 1, currentIdx: 0, turnOrder: [], monsters: [] };

    case 'monster_spawn': {
      // Auto-activate: spawning an enemy STARTS combat even when the model
      // skipped combat_start (observed 2026-05-29: qwen3 emits monster_spawn +
      // initiative_set but omits combat_start → encounter stayed inactive and
      // the tracker never showed). The first combat event resets to a fresh
      // active encounter; subsequent spawns append to the running one.
      // Reset when starting a NEW fight: inactive, OR "active" but every monster
      // is already dead (the previous fight ended yet combat_end never fired — the
      // local model emits it as narration text, not a tool call). Spawning a fresh
      // enemy into an all-dead encounter means a new combat → discard the corpses.
      // Otherwise (active with ≥1 live monster) append — a reinforcement.
      const allMonstersDead =
        state.monsters.length > 0 && state.monsters.every((m) => !m.isAlive);
      const base: EncounterState =
        state.active && !allMonstersDead
          ? next
          : { active: true, round: 1, currentIdx: 0, turnOrder: [], monsters: [] };
      const { id, name, hpMax, ac, initiativeBonus, cr } = event.payload;
      // Idempotent: skip duplicate spawns (deterministic replay invariant).
      if (base.monsters.some((m) => m.id === id)) return base;
      const monster: EncounterState['monsters'][number] = {
        id,
        name,
        hpCurrent: hpMax,
        hpMax,
        isAlive: true,
        conditions: [],
      };
      if (ac !== undefined) monster.ac = ac;
      if (initiativeBonus !== undefined) monster.initiativeBonus = initiativeBonus;
      if (cr !== undefined) monster.cr = cr;
      base.monsters.push(monster);
      // Deterministic unique naming: when ≥2 monsters share a base name,
      // number them ALL (e.g. "X 1", "X 2") so every name in the tracker is unique.
      return deduplicateMonsterNames(base);
    }

    case 'initiative_set': {
      // Auto-activate (same rationale as monster_spawn): setting initiative
      // starts combat even if combat_start was skipped.
      const base: EncounterState = state.active
        ? next
        : { active: true, round: 1, currentIdx: 0, turnOrder: [], monsters: [] };
      base.turnOrder = [...event.payload.order];
      base.currentIdx = 0;
      return base;
    }

    case 'turn_advance': {
      if (!state.active) return next; // defensive
      if (state.turnOrder.length === 0) return next; // edge case: no actors yet
      // Advance to the next actor, SKIPPING dead monster actors. A dead monster
      // left in the turnOrder (the model puts them there, and monsters die
      // mid-combat) would otherwise STALL the turn — the handoff hands it a
      // "monster turn" it can never take. PCs are never in `monsters`, so they
      // are never skipped; live monsters are not skipped. Bounded by
      // turnOrder.length so an all-dead order cannot loop forever (it lands and
      // combat_end / v3 takes over).
      const isDeadMonster = (actorId: string): boolean => {
        const m = state.monsters.find((mm) => mm.id === actorId);
        return m !== undefined && !m.isAlive;
      };
      let idx = state.currentIdx;
      let wrapped = false;
      for (let step = 0; step < state.turnOrder.length; step++) {
        const adv = idx + 1;
        if (adv >= state.turnOrder.length) {
          idx = 0;
          wrapped = true;
        } else {
          idx = adv;
        }
        if (!isDeadMonster(state.turnOrder[idx]!.actorId)) break;
      }
      next.currentIdx = idx;
      if (wrapped) next.round = state.round + 1;
      return next;
    }

    case 'monster_hp_change': {
      if (!state.active) return next; // defensive
      const { id, delta } = event.payload;
      const monsterIdx = next.monsters.findIndex((m) => m.id === id);
      if (monsterIdx === -1) return next; // unknown monster id — defensive skip
      const monster = next.monsters[monsterIdx]!;
      monster.hpCurrent = Math.max(0, monster.hpCurrent + delta);
      monster.isAlive = monster.hpCurrent > 0;
      return next;
    }

    case 'combat_end': {
      next.active = false;
      return next;
    }

    default:
      // Non-encounter event — no-op. The encounter reducer does not throw
      // on unknown event types (defensive / forward-compat).
      return next;
  }
}

/**
 * Replay an ordered list of `VaultEventEnvelope`s.
 *
 * Returns `{ chars, encounter }` — both reducers run in a SINGLE pass over
 * the event log. The encounter reducer is additive: it does not change the
 * `chars` Map semantics established by Phase 02/03.
 *
 * Algorithm:
 *   1. Iterate envelopes in order.
 *   2. `campaign_initialized` seeds the chars Map (character-only; not
 *      encounter).
 *   3. Encounter-scoped events (`ENCOUNTER_EVENT_TYPES.has(env.type)`) go
 *      to `applyEncounterEvent`. They have no `payload.character`.
 *   4. All other character events target one character by `payload.character`
 *      UUID. Unseeded characters are skipped with a warning.
 */
export function replayEvents(
  envelopes: VaultEventEnvelope[],
): { chars: Map<string, CharacterState>; encounter: EncounterState } {
  const states = new Map<string, CharacterState>();
  let encounterState: EncounterState = structuredClone(INITIAL_ENCOUNTER_STATE);

  for (const env of envelopes) {
    // -----------------------------------------------------------------------
    // Encounter-scoped routing — ENCOUNTER_EVENT_TYPES.has is O(1).
    // These events have no payload.character so the character path must NOT
    // run for them.
    // -----------------------------------------------------------------------
    if (ENCOUNTER_EVENT_TYPES.has(env.type)) {
      encounterState = applyEncounterEvent(
        encounterState,
        { type: env.type, payload: env.payload } as VaultEvent,
      );
      continue;
    }

    // -----------------------------------------------------------------------
    // Character-scoped routing (Phase 02/03 events + campaign_initialized).
    // -----------------------------------------------------------------------
    if (env.type === 'campaign_initialized') {
      const payload = env.payload as { characters: VaultSeedCharacter[] };
      for (const c of payload.characters) {
        states.set(c.id, INITIAL_CHARACTER_STATE(c));
      }
      continue;
    }
    // Mutation events all carry `payload.character: string` (character UUID).
    const charId = (env.payload as { character: string }).character;
    const current = states.get(charId);
    if (!current) {
      // Event for an unseeded character — defensive skip with warning.
      // The dispatcher emits a seed event before any mutation, so this
      // only fires on manually-corrupted events.md.
      console.warn(
        '[projector] event for unseeded character, skipping:',
        charId,
        env.type,
      );
      continue;
    }
    const next = applyEvent(
      current,
      { type: env.type, payload: env.payload } as VaultEvent,
    );
    next.last_event_id = env.id;
    next.last_updated = env.timestamp;
    states.set(charId, next);
  }
  return { chars: states, encounter: encounterState };
}

/**
 * Read events.md from disk and parse each line as a JSON envelope.
 *
 * Fail-fast contract (spike 008 §"Resilience to corruption"):
 *   - Each line must parse via `JSON.parse`. A corrupted line aborts
 *     replay with `[projector] corrupt event at line N: <message>`.
 *     The line number is 1-based, matching the operator's text-editor
 *     view of events.md.
 *   - Empty file → empty array (a brand-new campaign before its first
 *     event has nothing to replay).
 *   - Missing file → empty array (same as empty file; the writer creates
 *     the file lazily on first append).
 *
 * Why the error message preserves the line number: when an operator's
 * recovery procedure flags a corruption, the offending line is the
 * primary diagnostic. Surfacing it directly in the thrown error cuts
 * straight to the diagnostic loop without log-scanning.
 */
export async function parseEventsFile(path: string): Promise<VaultEventEnvelope[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const lines = trimmed.split('\n');
  const envelopes: VaultEventEnvelope[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue; // tolerate blank lines mid-file
    try {
      envelopes.push(JSON.parse(line) as VaultEventEnvelope);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[projector] corrupt event at line ${i + 1}: ${message}`,
      );
    }
  }
  return envelopes;
}

/**
 * Regenerate the materialized view for a single character.
 *
 * Steps:
 *   1. Parse events.md from disk via `parseEventsFile`.
 *   2. Replay the full event list to derive per-character state.
 *   3. Look up the target character's state.
 *   4. Resolve the on-disk view path under `characters/<slug>-<id8>.md`.
 *   5. `mkdir -p` the parent directory (a brand-new campaign has no
 *      `characters/` subdir yet).
 *   6. Write the serialized view atomically (single `writeFile` call —
 *      POSIX `write(2)` is atomic for whole-file writes under 4KB; a
 *      typical view is ~500 bytes).
 *
 * Throws when the target `characterId` is not present in the replayed
 * state. The dispatcher (plan 02-07) calls this only after appending an
 * event whose payload references a seeded character; an "unknown
 * character" throw means the operator's events.md is corrupted or
 * out-of-sync with the LLM's view of the campaign roster.
 */
export async function regenerateCharacterView(
  campaignId: string,
  characterId: string,
): Promise<void> {
  const envelopes = await parseEventsFile(eventsPath(campaignId));
  const { chars } = replayEvents(envelopes);
  const state = chars.get(characterId);
  if (!state) {
    throw new Error(
      `[projector] regenerateCharacterView: character ${characterId} not seeded in campaign ${campaignId}`,
    );
  }
  const viewPath = characterViewPath(campaignId, state.name, characterId);
  await mkdir(dirname(viewPath), { recursive: true });
  await writeFile(viewPath, serializeView(state), 'utf8');
}

/**
 * Regenerate the `combat.md` materialized view for a campaign.
 *
 * Steps:
 *   1. Parse events.md from disk via `parseEventsFile`.
 *   2. Replay to get the encounter state.
 *   3. Serialize via `serializeCombatView`.
 *   4. Write to `<campaignDir>/combat.md` (mkdir -p parent).
 *
 * Phase 06 D1 — called by `regenerateAffectedViews` whenever an encounter
 * event is applied. The snapshot wiring in plan 06-02 reads this file.
 */
export async function regenerateCombatView(campaignId: string): Promise<void> {
  const envelopes = await parseEventsFile(eventsPath(campaignId));
  const { encounter } = replayEvents(envelopes);
  const combatPath = join(campaignDir(campaignId), 'combat.md');
  await mkdir(dirname(combatPath), { recursive: true });
  await writeFile(combatPath, serializeCombatView(encounter), 'utf8');
}

/**
 * Dispatcher hook — synchronously regenerate all views affected by the
 * just-appended event.
 *
 * Affected-set rules (Phase 06 D1 extended):
 *   - Encounter-scoped events (`ENCOUNTER_EVENT_TYPES.has(event.type)`) —
 *     regenerate `combat.md` and return early. These events have no
 *     `payload.character`, so the character-regen path MUST NOT run.
 *   - `campaign_initialized` — regenerate every character in the seed
 *     payload (the campaign just bootstrapped; all views need to exist
 *     before the LLM can read any of them).
 *   - All other event types — regenerate the single character referenced
 *     by `payload.character` (the field is the character UUID).
 *
 * Called by the apply_event dispatcher (plan 02-07) synchronously after
 * `EventsWriter.applyEvent` returns. Spike 008 + Decision 2 jointly
 * mandate synchronous regen so the next `read_vault_multi` sees fresh
 * state without an eventual-consistency window.
 */
export async function regenerateAffectedViews(
  campaignId: string,
  event: VaultEventEnvelope,
): Promise<void> {
  // Phase 06 D1 — encounter-scoped events regenerate combat.md and return.
  // These events have no payload.character; the character-regen path below
  // must not execute for them (it would crash on undefined charId).
  if (ENCOUNTER_EVENT_TYPES.has(event.type)) {
    await regenerateCombatView(campaignId);
    return;
  }

  if (event.type === 'campaign_initialized') {
    const payload = event.payload as { characters: VaultSeedCharacter[] };
    await Promise.all(
      payload.characters.map((c) => regenerateCharacterView(campaignId, c.id)),
    );
    return;
  }
  const charId = (event.payload as { character: string }).character;
  await regenerateCharacterView(campaignId, charId);
}

/**
 * Serialize a `CharacterState` into a frontmatter+body markdown view.
 *
 * Hand-rolled YAML emitter (no `yaml` dependency — the shape is small,
 * known, and append-only across phases). Output contract:
 *
 *   1. Byte-stable for the same input. Spike 013's DR test depends on
 *      this: corrupt a view, regenerate via replay, assert byte-for-byte
 *      equality.
 *   2. Deterministic key ordering — `conditions` and `inventory` are
 *      already sorted by the reducer; `spell_slots` keys are sorted at
 *      serialize time (the reducer never reorders Map keys directly).
 *   3. Frontmatter delimiter is `---`; body is a single `# <name>` header
 *      plus a do-not-edit notice. The LLM reads this via
 *      `read_vault_multi`.
 *   4. Empty arrays/maps emit inline (`conditions: []`, `inventory: []`,
 *      `spell_slots: {}`) rather than empty-block (`conditions:\n`)
 *      because the inline form is what the LLM-reading prompt expects
 *      and what most YAML linters prefer.
 *   5. String values are emitted via `JSON.stringify` so quotes, commas,
 *      and unicode escapes are handled consistently across `name`,
 *      `condition`, and `item` fields. Numeric values are emitted bare.
 *   6. `last_event_id` and `last_updated` are emitted only when present
 *      (a freshly-seeded state has no preceding event).
 */
export function serializeView(state: CharacterState): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${state.id}`);
  lines.push(`name: ${JSON.stringify(state.name)}`);
  lines.push(`hp_current: ${state.hp_current}`);
  lines.push(`hp_max: ${state.hp_max}`);

  if (state.conditions.length === 0) {
    lines.push('conditions: []');
  } else {
    lines.push('conditions:');
    for (const c of state.conditions) {
      lines.push(`  - ${JSON.stringify(c)}`);
    }
  }

  const slotKeys = Object.keys(state.spell_slots).sort();
  if (slotKeys.length === 0) {
    lines.push('spell_slots: {}');
  } else {
    lines.push('spell_slots:');
    for (const k of slotKeys) {
      const s = state.spell_slots[k]!;
      lines.push(`  "${k}": { max: ${s.max}, used: ${s.used} }`);
    }
  }

  if (state.inventory.length === 0) {
    lines.push('inventory: []');
  } else {
    lines.push('inventory:');
    for (const i of state.inventory) {
      lines.push(`  - { item: ${JSON.stringify(i.item)}, qty: ${i.qty} }`);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 03 fields — emitted AFTER the Phase 02 fields to preserve the
  // byte-stable prefix of existing view files. Numeric scalars first, then
  // structured (object/array) fields. parseView (below) defaults any
  // missing key to the same value `INITIAL_CHARACTER_STATE` uses, so a
  // Phase 02-only view file still round-trips through parseView.
  // -------------------------------------------------------------------------
  lines.push(`temp_hp: ${state.temp_hp}`);
  lines.push(`exhaustion_level: ${state.exhaustion_level}`);
  lines.push(`hit_dice_remaining: ${state.hit_dice_remaining}`);
  lines.push(`hit_dice_max: ${state.hit_dice_max}`);
  lines.push(`xp: ${state.xp}`);
  lines.push(`level: ${state.level}`);
  lines.push(
    `death_saves: { successes: ${state.death_saves.successes}, failures: ${state.death_saves.failures} }`,
  );
  lines.push(
    `flags: { stable: ${state.flags.stable}, dead: ${state.flags.dead}, inspiration: ${state.flags.inspiration} }`,
  );

  if (state.concentrating_on === null) {
    lines.push('concentrating_on: null');
  } else {
    const c = state.concentrating_on;
    lines.push(
      `concentrating_on: { spellSlug: ${JSON.stringify(c.spellSlug)}, slotLevel: ${c.slotLevel}, startedRound: ${c.startedRound} }`,
    );
  }

  if (state.attunements.length === 0) {
    lines.push('attunements: []');
  } else {
    lines.push('attunements:');
    // The reducer already keeps `attunements` sorted; re-sort here is
    // defensive against any future code path that builds a CharacterState
    // without going through the reducer.
    const sorted = [...state.attunements].sort();
    for (const a of sorted) {
      lines.push(`  - ${JSON.stringify(a)}`);
    }
  }

  if (state.equipped_focus === null) {
    lines.push('equipped_focus: null');
  } else {
    const f = state.equipped_focus;
    lines.push(
      `equipped_focus: { kind: ${JSON.stringify(f.kind)}, itemSlug: ${JSON.stringify(f.itemSlug)} }`,
    );
  }

  const resKeys = Object.keys(state.resources_used).sort();
  if (resKeys.length === 0) {
    lines.push('resources_used: {}');
  } else {
    lines.push('resources_used:');
    for (const k of resKeys) {
      // `k` here is a feature slug (e.g. "rage", "channel_divinity"). The
      // applicator never produces slugs with whitespace or YAML-significant
      // characters; we JSON.stringify defensively so a future slug change
      // can't break the parser.
      lines.push(`  ${JSON.stringify(k)}: ${state.resources_used[k]!}`);
    }
  }

  if (state.last_event_id !== undefined) {
    lines.push(`last_event_id: ${state.last_event_id}`);
  }
  if (state.last_updated !== undefined) {
    lines.push(`last_updated: ${state.last_updated}`);
  }

  lines.push('---');
  lines.push('');
  lines.push(`# ${state.name}`);
  lines.push('');
  lines.push(
    '(materialized view; do not edit — regenerated by the projector after each apply_event)',
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Serialize an `EncounterState` into a frontmatter markdown view (`combat.md`).
 *
 * Phase 06 D1 — hand-rolled YAML emitter, byte-stable for the same input.
 * Mirrors the `serializeView` pattern (no yaml dependency, deterministic
 * key ordering, `---` delimiters).
 *
 * When `encounter.active === false`: emits minimal frontmatter (`active: false`)
 * because there is no active encounter to render.
 *
 * When `encounter.active === true`: emits full encounter state:
 *   - active, round, currentIdx
 *   - turnOrder: YAML sequence of {actorId, initiative} items
 *   - monsters: YAML sequence of full monster stats
 *
 * Byte-stability: turnOrder and monsters are emitted in their list order
 * (authoritative from initiative_set / monster_spawn order — NOT re-sorted).
 * String values use JSON.stringify for consistent quoting.
 */
export function serializeCombatView(encounter: EncounterState): string {
  const lines: string[] = ['---'];

  if (!encounter.active) {
    lines.push('active: false');
    lines.push('---');
    lines.push('');
    lines.push('# Combat');
    lines.push('');
    lines.push('(no active encounter)');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('active: true');
  lines.push(`round: ${encounter.round}`);
  lines.push(`currentIdx: ${encounter.currentIdx}`);

  if (encounter.turnOrder.length === 0) {
    lines.push('turnOrder: []');
  } else {
    lines.push('turnOrder:');
    for (const t of encounter.turnOrder) {
      lines.push(`  - actorId: ${JSON.stringify(t.actorId)}`);
      lines.push(`    initiative: ${t.initiative}`);
    }
  }

  if (encounter.monsters.length === 0) {
    lines.push('monsters: []');
  } else {
    lines.push('monsters:');
    for (const m of encounter.monsters) {
      lines.push(`  - id: ${JSON.stringify(m.id)}`);
      lines.push(`    name: ${JSON.stringify(m.name)}`);
      lines.push(`    hpCurrent: ${m.hpCurrent}`);
      lines.push(`    hpMax: ${m.hpMax}`);
      if (m.ac !== undefined) {
        lines.push(`    ac: ${m.ac}`);
      }
      if (m.initiativeBonus !== undefined) {
        lines.push(`    initiativeBonus: ${m.initiativeBonus}`);
      }
      lines.push(`    isAlive: ${m.isAlive}`);
      if (m.conditions.length === 0) {
        lines.push('    conditions: []');
      } else {
        lines.push('    conditions:');
        for (const c of m.conditions) {
          lines.push(`      - ${JSON.stringify(c)}`);
        }
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('# Combat');
  lines.push('');
  lines.push(
    '(materialized view; do not edit — regenerated by the projector after each apply_event)',
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * TEST SEAM — reverse of `serializeView` for the Vitest round-trip
 * property check (plan must_have: "parseView(serializeView(state)) ===
 * state, modulo whitespace").
 *
 * Production code does NOT call this. The LLM reads materialized views
 * via the `read_vault_multi` tool only; the projector treats views as
 * write-only outputs. This function exists so the regression suite can
 * assert that `serializeView` round-trips through a hand-rolled parser —
 * proving the on-disk format is parseable by code that doesn't trust the
 * projector's internal representation.
 *
 * Returns `null` when the input does not look like a serialized view
 * (missing frontmatter delimiters). The parser is intentionally narrow:
 * it parses ONLY the shape emitted by `serializeView`, not arbitrary YAML.
 */
export function parseView(content: string): CharacterState | null {
  // Locate the two `---` delimiters that bracket the frontmatter.
  const firstDelim = content.indexOf('---');
  if (firstDelim === -1) return null;
  const afterFirst = firstDelim + 3;
  const secondDelim = content.indexOf('\n---', afterFirst);
  if (secondDelim === -1) return null;
  const frontmatter = content.slice(afterFirst, secondDelim).trim();
  const fmLines = frontmatter.split('\n');

  // Skeleton with the mandatory fields. Optional fields default to
  // empty / undefined; the loop below populates them as it scans.
  // Phase 03 fields default to the same values `INITIAL_CHARACTER_STATE`
  // uses — so a Phase 02-only frontmatter (no Phase 03 keys) still
  // parses to a valid Phase 03 `CharacterState`.
  const state: CharacterState = {
    id: '',
    name: '',
    hp_current: 0,
    hp_max: 0,
    conditions: [],
    spell_slots: {},
    inventory: [],
    temp_hp: 0,
    death_saves: { successes: 0, failures: 0 },
    flags: { stable: false, dead: false, inspiration: false },
    concentrating_on: null,
    exhaustion_level: 0,
    hit_dice_remaining: 0,
    hit_dice_max: 0,
    attunements: [],
    equipped_focus: null,
    resources_used: {},
    xp: 0,
    level: 1,
  };

  let mode:
    | 'top'
    | 'conditions'
    | 'spell_slots'
    | 'inventory'
    | 'attunements'
    | 'resources_used' = 'top';

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i]!;
    if (line.length === 0) continue;

    // Lines beginning with two spaces belong to whichever multi-line
    // block we're currently inside (conditions / spell_slots / inventory
    // / attunements / resources_used).
    if (line.startsWith('  ')) {
      const inner = line.slice(2);
      if (mode === 'conditions') {
        // Format: `- "<condition>"`
        const m = inner.match(/^-\s+(.+)$/);
        if (m) {
          state.conditions.push(JSON.parse(m[1]!) as string);
        }
        continue;
      }
      if (mode === 'spell_slots') {
        // Format: `"<level>": { max: <n>, used: <n> }`
        const m = inner.match(/^"([^"]+)":\s*\{\s*max:\s*(\d+),\s*used:\s*(\d+)\s*\}$/);
        if (m) {
          state.spell_slots[m[1]!] = {
            max: parseInt(m[2]!, 10),
            used: parseInt(m[3]!, 10),
          };
        }
        continue;
      }
      if (mode === 'inventory') {
        // Format: `- { item: "<name>", qty: <n> }`
        const m = inner.match(/^-\s+\{\s*item:\s*("(?:[^"\\]|\\.)*"),\s*qty:\s*(\d+)\s*\}$/);
        if (m) {
          state.inventory.push({
            item: JSON.parse(m[1]!) as string,
            qty: parseInt(m[2]!, 10),
          });
        }
        continue;
      }
      if (mode === 'attunements') {
        // Format: `- "<itemSlug>"` (same idiom as conditions block).
        const m = inner.match(/^-\s+(.+)$/);
        if (m) {
          state.attunements.push(JSON.parse(m[1]!) as string);
        }
        continue;
      }
      if (mode === 'resources_used') {
        // Format: `"<resourceKey>": <integer>`
        const m = inner.match(/^("(?:[^"\\]|\\.)*"):\s*(\d+)$/);
        if (m) {
          state.resources_used[JSON.parse(m[1]!) as string] = parseInt(m[2]!, 10);
        }
        continue;
      }
      // Indented line in an unknown mode — skip defensively.
      continue;
    }

    // Top-level key: value parsing.
    if (line === 'conditions: []') {
      state.conditions = [];
      mode = 'top';
      continue;
    }
    if (line === 'spell_slots: {}') {
      state.spell_slots = {};
      mode = 'top';
      continue;
    }
    if (line === 'inventory: []') {
      state.inventory = [];
      mode = 'top';
      continue;
    }
    if (line === 'attunements: []') {
      state.attunements = [];
      mode = 'top';
      continue;
    }
    if (line === 'resources_used: {}') {
      state.resources_used = {};
      mode = 'top';
      continue;
    }
    if (line === 'conditions:') {
      mode = 'conditions';
      continue;
    }
    if (line === 'spell_slots:') {
      mode = 'spell_slots';
      continue;
    }
    if (line === 'inventory:') {
      mode = 'inventory';
      continue;
    }
    if (line === 'attunements:') {
      mode = 'attunements';
      continue;
    }
    if (line === 'resources_used:') {
      mode = 'resources_used';
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    mode = 'top';

    switch (key) {
      case 'id':
        state.id = value;
        break;
      case 'name':
        state.name = JSON.parse(value) as string;
        break;
      case 'hp_current':
        state.hp_current = parseInt(value, 10);
        break;
      case 'hp_max':
        state.hp_max = parseInt(value, 10);
        break;
      // -----------------------------------------------------------------
      // Phase 03 scalar / inline-object keys. Multi-line blocks
      // (attunements, resources_used) are handled by the mode switches
      // above; here we capture the inline keys and the explicit-null
      // serializations.
      // -----------------------------------------------------------------
      case 'temp_hp':
        state.temp_hp = parseInt(value, 10);
        break;
      case 'exhaustion_level':
        state.exhaustion_level = parseInt(value, 10);
        break;
      case 'hit_dice_remaining':
        state.hit_dice_remaining = parseInt(value, 10);
        break;
      case 'hit_dice_max':
        state.hit_dice_max = parseInt(value, 10);
        break;
      case 'xp':
        state.xp = parseInt(value, 10);
        break;
      case 'level':
        state.level = parseInt(value, 10);
        break;
      case 'death_saves': {
        // Format: `{ successes: <n>, failures: <n> }`
        const m = value.match(/^\{\s*successes:\s*(\d+),\s*failures:\s*(\d+)\s*\}$/);
        if (m) {
          state.death_saves = {
            successes: parseInt(m[1]!, 10),
            failures: parseInt(m[2]!, 10),
          };
        }
        break;
      }
      case 'flags': {
        // Format: `{ stable: <bool>, dead: <bool>, inspiration: <bool> }`
        const m = value.match(
          /^\{\s*stable:\s*(true|false),\s*dead:\s*(true|false),\s*inspiration:\s*(true|false)\s*\}$/,
        );
        if (m) {
          state.flags = {
            stable: m[1] === 'true',
            dead: m[2] === 'true',
            inspiration: m[3] === 'true',
          };
        }
        break;
      }
      case 'concentrating_on': {
        if (value === 'null') {
          state.concentrating_on = null;
        } else {
          // Format: `{ spellSlug: "<slug>", slotLevel: <n>, startedRound: <n> }`
          const m = value.match(
            /^\{\s*spellSlug:\s*("(?:[^"\\]|\\.)*"),\s*slotLevel:\s*(\d+),\s*startedRound:\s*(\d+)\s*\}$/,
          );
          if (m) {
            state.concentrating_on = {
              spellSlug: JSON.parse(m[1]!) as string,
              slotLevel: parseInt(m[2]!, 10),
              startedRound: parseInt(m[3]!, 10),
            };
          }
        }
        break;
      }
      case 'equipped_focus': {
        if (value === 'null') {
          state.equipped_focus = null;
        } else {
          // Format: `{ kind: "<kind>", itemSlug: "<slug>" }`
          const m = value.match(
            /^\{\s*kind:\s*("(?:[^"\\]|\\.)*"),\s*itemSlug:\s*("(?:[^"\\]|\\.)*")\s*\}$/,
          );
          if (m) {
            const kind = JSON.parse(m[1]!) as string;
            // Narrow `kind` defensively to the validator's enum. A
            // corrupted view with an unknown kind value falls back to
            // null (cleaner than throwing — Pitfall 6 graceful
            // degradation idiom).
            if (kind === 'arcane' || kind === 'druidic' || kind === 'holy' || kind === 'instrument') {
              state.equipped_focus = {
                kind,
                itemSlug: JSON.parse(m[2]!) as string,
              };
            }
          }
        }
        break;
      }
      case 'last_event_id':
        state.last_event_id = value;
        break;
      case 'last_updated':
        state.last_updated = value;
        break;
      default:
        // Unknown top-level key — silently ignore (forward-compat).
        break;
    }
  }

  return state;
}
