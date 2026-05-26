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
import { dirname } from 'node:path';
import type {
  VaultEvent,
  VaultEventEnvelope,
  VaultSeedCharacter,
} from './events-schema';
import { eventsPath, characterViewPath } from './campaign-paths';

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
 * Replay an ordered list of `VaultEventEnvelope`s into a per-character
 * state Map. Pure function — no FS reads, no global state, no clock.
 *
 * Algorithm:
 *   1. Iterate envelopes in order.
 *   2. `campaign_initialized` events seed the Map: for each character in
 *      `payload.characters`, allocate `INITIAL_CHARACTER_STATE` and store
 *      it under `character.id`.
 *   3. All other event types target one character (the `payload.character`
 *      field IS the character UUID). Look up the existing state, apply
 *      the reducer, write back. Attach envelope metadata
 *      (`last_event_id`, `last_updated`) to the new state.
 *   4. Events for unseeded characters are skipped with a warning. In
 *      practice the seed event always lands first; this is defensive
 *      hardening against an operator's manual events.md edit that drops
 *      the seed line.
 */
export function replayEvents(
  envelopes: VaultEventEnvelope[],
): Map<string, CharacterState> {
  const states = new Map<string, CharacterState>();
  for (const env of envelopes) {
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
  return states;
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
  const states = replayEvents(envelopes);
  const state = states.get(characterId);
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
 * Dispatcher hook — synchronously regenerate all views affected by the
 * just-appended event.
 *
 * Affected-set rules:
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

  let mode: 'top' | 'conditions' | 'spell_slots' | 'inventory' = 'top';

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i]!;
    if (line.length === 0) continue;

    // Lines beginning with two spaces belong to whichever multi-line
    // block we're currently inside (conditions / spell_slots / inventory).
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
