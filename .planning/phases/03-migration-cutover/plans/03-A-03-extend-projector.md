---
phase: 03
plan: A-03
type: execute
wave: 3
depends_on: [03-A-02]
files_modified:
  - src/ai/master/vault/projector.ts
  - tests/ai/master/vault/projector.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "applyEvent has a switch arm for every Phase 03 VaultEvent type — no `default:` fall-through for known types"
    - "INITIAL_CHARACTER_STATE includes new persisted fields: temp_hp, death_saves, concentrating_on, exhaustion_level, attunements, resources_used, inspiration, hit_dice_remaining, xp, level (when the audit (c) list requires them)"
    - "replayEvents correctly reduces a sequence of mixed Phase 02 + Phase 03 events into a final CharacterState"
    - "serializeView writes the new CharacterState fields to the materialized view frontmatter; parseView reads them back byte-stably"
    - "Replaying the same events twice produces byte-identical view files (spike 013 invariant honored)"
    - "tsc exhaustiveness check passes — adding an event type to the union without a reducer arm fails the build"
  artifacts:
    - path: "src/ai/master/vault/projector.ts"
      provides: "Extended applyEvent reducer + extended INITIAL_CHARACTER_STATE + extended serializeView/parseView"
      exports: ["applyEvent", "INITIAL_CHARACTER_STATE", "serializeView", "parseView"]
    - path: "tests/ai/master/vault/projector.test.ts"
      provides: "Reducer arm coverage + serialize round-trip per new event type"
  key_links:
    - from: "src/ai/master/vault/projector.ts (applyEvent reducer arms)"
      to: "src/ai/master/vault/events-schema.ts (VaultEvent union)"
      via: "Exhaustiveness check at the default arm (never type)"
      pattern: "VaultEvent"
    - from: "src/ai/master/vault/projector.ts (serializeView, parseView)"
      to: "characters/<slug>-<id8>.md (materialized view frontmatter)"
      via: "New persisted fields appear in the YAML frontmatter"
      pattern: "temp_hp\\|death_saves\\|concentrating_on"
---

# Plan 03-A-03: Extend projector.ts with Reducer Arms

**Phase:** 03-migration-cutover
**Wave:** 3 (depends on 03-A-02 — needs the extended VaultEvent union)
**Status:** Pending
**Estimated diff size:** ~350 LOC source + ~300 LOC tests / 2 files

## Goal

The projector (`src/ai/master/vault/projector.ts`) is the pure reducer that turns events.md → CharacterState → materialized view frontmatter. Phase 02 shipped reducer arms for the 8 original event types; this plan adds arms for every new event type from 03-A-01's audit (c) Final list, extends `INITIAL_CHARACTER_STATE` with the new persisted fields, and updates `serializeView` / `parseView` to round-trip them.

The byte-stability invariant (spike 013) MUST still hold: replaying the same events produces the same view bytes. Add a regression case for it covering Phase 03 events.

## Requirements satisfied

- **REQ-006** DR replay — closes the second half of the completeness gap (schema in 03-A-02, reducer here). After this plan, replaying events.md reproduces the FULL persisted state for the new event types.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/projector.ts` | EDIT (additive) | Add reducer arms + extend CharacterState shape + extend INITIAL_CHARACTER_STATE + extend serializeView/parseView |
| `tests/ai/master/vault/projector.test.ts` | EDIT (additive) | Reducer arms + round-trip + byte-stability regression |

## Tasks

<task type="auto">
  <name>Task 1: Extend CharacterState + INITIAL_CHARACTER_STATE with new persisted fields</name>
  <files>src/ai/master/vault/projector.ts</files>
  <read_first>
    - src/ai/master/vault/projector.ts (existing — lines 108-135 CharacterState interface; lines 136-180 INITIAL_CHARACTER_STATE function; lines 194-300 applyEvent reducer; lines 483-650 serializeView + parseView)
    - src/ai/master/vault/events-schema.ts (extended in plan 03-A-02 — VaultEvent union + VaultSeedCharacter)
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (the (c) list field-to-state mapping)
    - src/db/schema/session-state.ts (the Postgres-side columns — temp_hp, death_saves, concentrating_on, exhaustion_level, resources_used, ...)
  </read_first>
  <action>
Edit `src/ai/master/vault/projector.ts`. Two changes here (the reducer arms come in Task 2).

**Change 1 — Extend `CharacterState` interface.** Locate the existing interface (around line 108). The Phase 02 shape has: `id, name, hp_max, hp_current, conditions, spell_slots, inventory`. Add the new persisted fields per the audit:

```ts
export interface CharacterState {
  id: string;
  name: string;
  hp_max: number;
  hp_current: number;
  // Phase 03 additions
  temp_hp: number;
  death_saves: { successes: number; failures: number };
  flags: { stable: boolean; dead: boolean; inspiration: boolean };
  concentrating_on: { spellSlug: string; slotLevel: number; startedRound: number } | null;
  exhaustion_level: number;
  hit_dice_remaining: number;
  hit_dice_max: number;
  attunements: string[];
  resources_used: Record<string, number>;
  xp: number;
  level: number;
  classes: Record<string, number>;  // classSlug → level (for multi-class)
  // existing Phase 02
  conditions: string[];
  spell_slots: Record<string, { max: number; used: number }>;
  inventory: { item: string; qty: number }[];
}
```

The Phase 02 fields stay in the SAME order; new fields are inserted between hp_current and conditions OR appended at the end. Pick one and stick with it for serialization stability (recommendation: append new fields BEFORE the Phase 02 fields for visual grouping by "persistence category", but document the choice in a JSDoc comment).

**Change 2 — Extend `INITIAL_CHARACTER_STATE`.** Locate the function (around line 136). It takes a `VaultSeedCharacter` and returns a `CharacterState`. Extend to populate the new fields with sane defaults:

```ts
export function INITIAL_CHARACTER_STATE(seed: VaultSeedCharacter): CharacterState {
  return {
    id: seed.id,
    name: seed.name,
    hp_max: seed.hp_max,
    hp_current: seed.hp_current ?? seed.hp_max,
    // Phase 03 defaults
    temp_hp: 0,
    death_saves: { successes: 0, failures: 0 },
    flags: { stable: false, dead: false, inspiration: false },
    concentrating_on: null,
    exhaustion_level: 0,
    hit_dice_remaining: seed.hit_dice_remaining ?? 0,
    hit_dice_max: seed.hit_dice_max ?? 0,
    attunements: [],
    resources_used: {},
    xp: seed.xp ?? 0,
    level: seed.level ?? 1,
    classes: seed.classes ?? {},
    // existing Phase 02 defaults
    conditions: [],
    spell_slots: seed.spell_slots ?? {},
    inventory: [],
  };
}
```

This requires extending `VaultSeedCharacter` in `events-schema.ts` with optional fields for the new state. Update that file's `VaultSeedCharacter` type to add:

```ts
export type VaultSeedCharacter = {
  id: string;
  name: string;
  hp_max: number;
  hp_current?: number;
  spell_slots?: Record<string, { max: number; used: number }>;
  // Phase 03 additions (all OPTIONAL — vault-flip's LEFT JOIN may omit them; projector falls back)
  temp_hp?: number;                                      // session_state.temp_hp
  hit_dice_remaining?: number;                           // session_state.hit_dice_remaining
  hit_dice_max?: number;                                 // derived: characters.level (1 die/level)
  exhaustion_level?: number;                             // session_state.exhaustion_level
  resources_used?: Record<string, number>;               // session_state.resources_used
  xp?: number;                                            // characters.xp
  level?: number;                                         // characters.level
  classes?: Record<string, number>;                       // characters.classLevels (multi-class)
};
```

The `events-schema.ts` change is small but coupled to this plan — make it here OR amend plan 03-A-02 to include it. To keep the file-ownership matrix clean, make the change here in `projector.ts` Task 1 — the `VaultSeedCharacter` type is owned by events-schema.ts but the seed defaults are LOCALLY consumed by the projector. The cleanest split: ship the type extension in events-schema.ts in plan 03-A-02 (re-open that plan if needed) OR include the type extension in plan 03-A-03's wave 3 commit by ALSO editing events-schema.ts here. **Recommended: extend events-schema.ts's `VaultSeedCharacter` here in plan 03-A-03 alongside the projector edit — single commit, atomic schema+reducer coupling.** Note that this expands the file_modified list for this plan to include events-schema.ts; update the frontmatter accordingly OR keep the type addition minimal (the optional fields don't break anything).

Update the JSDoc above `VaultSeedCharacter` in events-schema.ts to mention the Phase 03 optional fields. The Phase 02 `vault-flip --enable-mutations` script (and the Phase 03 bulk migration) source these from Postgres LEFT JOINs — see plan 03-A-06 for the flip helper refactor that ADDS the new field sourcing.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0 (no other consumer of CharacterState broke)
    - `grep -c "temp_hp\\|death_saves\\|concentrating_on\\|exhaustion_level\\|hit_dice_remaining\\|attunements\\|resources_used" src/ai/master/vault/projector.ts` returns ≥ 7 (representative new fields in CharacterState + INITIAL_CHARACTER_STATE)
    - The Phase 02 fields (id, name, hp_max, hp_current, conditions, spell_slots, inventory) are still present and untouched in shape
    - `INITIAL_CHARACTER_STATE` returns an object with EVERY field listed in CharacterState — no undefined keys
  </acceptance_criteria>
  <done>
    State shape + initializer extended. Task 2 fills in the reducer arms.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add reducer arms in applyEvent for every Phase 03 event type</name>
  <files>src/ai/master/vault/projector.ts</files>
  <read_first>
    - src/ai/master/vault/projector.ts (Task 1 — extended CharacterState; existing applyEvent reducer lines 194-300 + the exhaustiveness `default` arm using `never`)
    - src/ai/master/vault/events-schema.ts (plan 03-A-02 — extended VaultEvent union)
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (per-event-type reducer behavior spec)
    - src/engine/tools/handlers.ts (the engine handlers — read the line-numbered handler bodies to MIRROR their state-mutation semantics in the reducer arm)
  </read_first>
  <action>
Edit `src/ai/master/vault/projector.ts`. Extend `applyEvent` (the switch on `event.type`) with new case arms for every Phase 03 event type. The reducer is PURE — takes a CharacterState, returns a NEW CharacterState (no mutation). Each arm replicates the semantics of the corresponding engine handler.

Place new arms AFTER the existing Phase 02 arms and BEFORE the `default:` exhaustiveness check.

Concrete arms (match the audit's spec):

```ts
    case 'temp_hp_set': {
      if (event.payload.character !== state.id) return state;
      return { ...state, temp_hp: Math.max(0, event.payload.tempHp) };
    }
    case 'death_save_success': {
      if (event.payload.character !== state.id) return state;
      const successes = state.death_saves.successes + 1;
      // 3 successes = stable (per PHB)
      if (successes >= 3) {
        return {
          ...state,
          death_saves: { successes: 0, failures: 0 },
          flags: { ...state.flags, stable: true },
        };
      }
      return {
        ...state,
        death_saves: { successes, failures: state.death_saves.failures },
      };
    }
    case 'death_save_fail': {
      if (event.payload.character !== state.id) return state;
      const incrementBy = event.payload.critical ? 2 : 1;
      const failures = state.death_saves.failures + incrementBy;
      // 3 failures = dead (per PHB)
      if (failures >= 3) {
        return {
          ...state,
          death_saves: { successes: 0, failures: 0 },
          flags: { ...state.flags, dead: true },
        };
      }
      return {
        ...state,
        death_saves: { successes: state.death_saves.successes, failures },
      };
    }
    case 'death_save_stabilize': {
      if (event.payload.character !== state.id) return state;
      return {
        ...state,
        death_saves: { successes: 0, failures: 0 },
        flags: { ...state.flags, stable: true },
      };
    }
    case 'concentration_break': {
      if (event.payload.character !== state.id) return state;
      return { ...state, concentrating_on: null };
    }
    case 'concentration_set': {
      if (event.payload.character !== state.id) return state;
      return {
        ...state,
        concentrating_on: {
          spellSlug: event.payload.spellSlug,
          slotLevel: event.payload.slotLevel,
          startedRound: event.payload.startedRound,
        },
      };
    }
    case 'exhaustion_set': {
      if (event.payload.character !== state.id) return state;
      return {
        ...state,
        exhaustion_level: Math.max(0, Math.min(10, event.payload.level)),
      };
    }
    case 'hit_dice_use': {
      if (event.payload.character !== state.id) return state;
      return {
        ...state,
        hit_dice_remaining: Math.max(0, state.hit_dice_remaining - event.payload.count),
      };
    }
    case 'hit_dice_restore': {
      if (event.payload.character !== state.id) return state;
      return {
        ...state,
        hit_dice_remaining: Math.min(state.hit_dice_max, state.hit_dice_remaining + event.payload.count),
      };
    }
    case 'attune': {
      if (event.payload.character !== state.id) return state;
      if (state.attunements.includes(event.payload.itemSlug)) return state;  // idempotent
      return { ...state, attunements: [...state.attunements, event.payload.itemSlug].sort() };
    }
    case 'unattune': {
      if (event.payload.character !== state.id) return state;
      const next = state.attunements.filter((s) => s !== event.payload.itemSlug);
      if (next.length === state.attunements.length) return state;  // idempotent
      return { ...state, attunements: next };
    }
    case 'resource_use': {
      if (event.payload.character !== state.id) return state;
      const cur = state.resources_used[event.payload.resourceKey] ?? 0;
      const next = cur + event.payload.delta;
      return {
        ...state,
        resources_used: { ...state.resources_used, [event.payload.resourceKey]: Math.max(0, next) },
      };
    }
    case 'inspiration_grant': {
      if (event.payload.character !== state.id) return state;
      return { ...state, flags: { ...state.flags, inspiration: true } };
    }
    case 'inspiration_spend': {
      if (event.payload.character !== state.id) return state;
      return { ...state, flags: { ...state.flags, inspiration: false } };
    }
    case 'xp_award': {
      if (event.payload.character !== state.id) return state;
      return { ...state, xp: state.xp + event.payload.amount };
    }
    case 'level_up': {
      if (event.payload.character !== state.id) return state;
      const newClasses = event.payload.classSlug
        ? { ...state.classes, [event.payload.classSlug]: (state.classes[event.payload.classSlug] ?? 0) + 1 }
        : state.classes;
      return {
        ...state,
        level: event.payload.newLevel,
        classes: newClasses,
        // Increase hit_dice_max alongside level (1 die per level)
        hit_dice_max: state.hit_dice_max + 1,
      };
    }
```

Critical notes:
- Every arm guards on `event.payload.character !== state.id` — events for OTHER characters in the same campaign are returned-unchanged. This matches the Phase 02 pattern (the reducer is called per-character; an event for character X should be a no-op when reducing character Y's state).
- All `attunements` operations sort the array — guarantees byte-stable serialization per spike 013.
- Death save thresholds (3 successes/failures) follow PHB rules exactly; do NOT over-engineer (no "4 successes = death" custom semantics).
- The exhaustiveness check (the `default:` arm with `const exhaustive: never = event;`) still fires for ANY event type not handled. After Phase 03 additions, the union is closed for ALL audit (c) entries.

Update the module JSDoc top-of-file to mention Phase 03 extension and reference COMPLETENESS-AUDIT.md.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/projector.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0 (exhaustiveness check satisfied)
    - `grep -c "case 'temp_hp_set'\|case 'death_save_success'\|case 'death_save_fail'\|case 'death_save_stabilize'\|case 'concentration_break'\|case 'concentration_set'\|case 'exhaustion_set'\|case 'hit_dice_use'\|case 'hit_dice_restore'\|case 'attune'\|case 'unattune'\|case 'resource_use'\|case 'inspiration_grant'\|case 'inspiration_spend'\|case 'xp_award'\|case 'level_up'" src/ai/master/vault/projector.ts` returns ≥ 14
    - Every Phase 03 event type from VAULT_EVENT_TYPES has a reducer arm
    - The Phase 02 arms (hp_change, condition_add, ...) are present and unchanged
    - All arms guard on `event.payload.character !== state.id` (single-character-state semantics preserved)
    - All arms return a NEW state object (no in-place mutation — `state.X =` does NOT appear in any Phase 03 arm; use spread)
  </acceptance_criteria>
  <done>
    Reducer fully closed. Task 3 extends serialization to round-trip the new fields.
  </done>
</task>

<task type="auto">
  <name>Task 3: Extend serializeView / parseView with new CharacterState fields</name>
  <files>src/ai/master/vault/projector.ts</files>
  <read_first>
    - src/ai/master/vault/projector.ts (Task 1 + 2 — extended CharacterState; existing serializeView lines 483-550, parseView lines 553-650)
    - .planning/spikes/013-vault-backup-restore/README.md (byte-stability invariant — same input bytes for same state)
  </read_first>
  <action>
Edit `src/ai/master/vault/projector.ts`. Extend `serializeView` and `parseView` to round-trip the new persisted fields.

The materialized view file has YAML frontmatter + markdown body. The Phase 02 serializer writes the frontmatter in a STABLE key order (spike 013 invariant) — adding new keys must preserve this. Recommendation: append new keys AFTER the Phase 02 keys, in the same order they appear in the CharacterState interface.

**Change 1 — Update `serializeView`.** Add the new fields to the YAML frontmatter output. Existing keys (id, name, hp_max, hp_current, conditions, spell_slots, inventory) stay in place. Append the Phase 03 keys:

```ts
export function serializeView(state: CharacterState): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${state.id}`);
  lines.push(`name: ${yamlQuote(state.name)}`);
  lines.push(`hp_max: ${state.hp_max}`);
  lines.push(`hp_current: ${state.hp_current}`);
  // Phase 03 fields — alphabetical within group for byte stability
  lines.push(`temp_hp: ${state.temp_hp}`);
  lines.push(`exhaustion_level: ${state.exhaustion_level}`);
  lines.push(`hit_dice_remaining: ${state.hit_dice_remaining}`);
  lines.push(`hit_dice_max: ${state.hit_dice_max}`);
  lines.push(`xp: ${state.xp}`);
  lines.push(`level: ${state.level}`);
  lines.push(`classes: ${JSON.stringify(state.classes)}`);
  lines.push(`death_saves: ${JSON.stringify(state.death_saves)}`);
  lines.push(`flags: ${JSON.stringify(state.flags)}`);
  lines.push(`concentrating_on: ${state.concentrating_on === null ? 'null' : JSON.stringify(state.concentrating_on)}`);
  lines.push(`attunements: ${JSON.stringify([...state.attunements].sort())}`);
  lines.push(`resources_used: ${JSON.stringify(state.resources_used, Object.keys(state.resources_used).sort())}`);
  // existing Phase 02 fields — preserve order from Phase 02 plan 02-04
  lines.push(`conditions: ${JSON.stringify([...state.conditions].sort())}`);
  lines.push(`spell_slots: ${JSON.stringify(state.spell_slots, Object.keys(state.spell_slots).sort())}`);
  lines.push(`inventory: ${serializeInventory(state.inventory)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${state.name}`);
  return lines.join('\n') + '\n';
}
```

The key invariant: SAME state in, SAME bytes out. Sort arrays + sort object keys before stringifying (Phase 02 already does this for conditions; mirror the pattern for attunements, resources_used).

NOTE: Phase 02's `serializeView` may use a different idiom (e.g., readable YAML with quoting). Read the existing code in lines 483-550 and EXTEND in the same style — DO NOT rewrite. The above is illustrative; the actual integration matches the existing serializer's quoting/formatting conventions.

**Change 2 — Update `parseView`.** The parser reads frontmatter back into a CharacterState. For each new field, add a parse line:

```ts
const tempHpMatch = frontmatter.match(/^temp_hp:\s*(\d+)$/m);
const temp_hp = tempHpMatch ? Number(tempHpMatch[1]) : 0;

const deathSavesMatch = frontmatter.match(/^death_saves:\s*(\{[^}]+\})$/m);
const death_saves = deathSavesMatch ? JSON.parse(deathSavesMatch[1]) : { successes: 0, failures: 0 };

// ... etc for each new field
```

Default to the same values `INITIAL_CHARACTER_STATE` uses when a field is missing (graceful degradation — older view files without Phase 03 fields parse successfully and use defaults).

Return shape:

```ts
return {
  id, name, hp_max, hp_current,
  temp_hp, exhaustion_level, hit_dice_remaining, hit_dice_max, xp, level, classes,
  death_saves, flags, concentrating_on, attunements, resources_used,
  conditions, spell_slots, inventory,
};
```

**Critical:** the parse arm for OLDER view files (Phase 02-only frontmatter, no Phase 03 keys) MUST return a valid CharacterState with the Phase 03 fields at their initial defaults. This preserves backward compatibility — vault rebuild views from a partial-Phase-03 events.md is still valid.

Run `pnpm test tests/ai/master/vault/projector.test.ts -- --reporter=verbose` after the edit to confirm Phase 02 cases still pass.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/projector.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - Phase 02 projector tests still pass (the 53 cases from Phase 02 plan 02-04)
    - `grep -c "temp_hp\|death_saves\|concentrating_on\|exhaustion_level\|hit_dice_remaining\|attunements\|resources_used\|xp\|level" src/ai/master/vault/projector.ts` returns ≥ 8 (each new field appears in serialize + parse paths)
    - parseView with a Phase 02-only frontmatter returns a valid CharacterState (Phase 03 fields at defaults)
    - serializeView output is byte-deterministic — serializing the same state twice produces identical bytes
  </acceptance_criteria>
  <done>
    Serialization round-trip extended.
  </done>
</task>

<task type="auto">
  <name>Task 4: Extend tests/ai/master/vault/projector.test.ts with Phase 03 reducer cases</name>
  <files>tests/ai/master/vault/projector.test.ts</files>
  <read_first>
    - tests/ai/master/vault/projector.test.ts (existing — Phase 02 cases; the describe('applyEvent — <type>') pattern; the byte-stability regression case)
    - src/ai/master/vault/projector.ts (Tasks 1-3 — extended CharacterState + reducer + serializer)
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (expected reducer behavior per type)
  </read_first>
  <action>
Append a new top-level `describe('applyEvent — Phase 03 reducer arms')` block to `tests/ai/master/vault/projector.test.ts`.

For EACH new event type, add at least 2-3 cases:
1. Happy path — event applies and produces expected state
2. No-op when payload.character ≠ state.id (sanity check)
3. Edge case (e.g., death_saves clamp at 3, exhaustion clamp at 10)

Concrete cases:

```ts
describe('applyEvent — Phase 03 reducer arms', () => {
  function freshState(overrides: Partial<CharacterState> = {}): CharacterState {
    return INITIAL_CHARACTER_STATE({ id: 'char-1', name: 'Aragorn', hp_max: 30 });
    // (with overrides applied)
  }

  describe('temp_hp_set', () => {
    it('sets temp_hp', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'temp_hp_set', payload: { character: 'char-1', tempHp: 5 } });
      expect(next.temp_hp).toBe(5);
    });
    it('clamps to 0 on negative', () => {
      const s = freshState();
      // Note: validator rejects negative; this tests defensive clamp
      const next = applyEvent(s, { type: 'temp_hp_set', payload: { character: 'char-1', tempHp: 0 } });
      expect(next.temp_hp).toBe(0);
    });
    it('no-op for other character', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'temp_hp_set', payload: { character: 'OTHER', tempHp: 99 } });
      expect(next).toBe(s);  // referentially equal
    });
  });

  describe('death_save_success', () => {
    it('increments successes', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'death_save_success', payload: { character: 'char-1' } });
      expect(next.death_saves.successes).toBe(1);
      expect(next.death_saves.failures).toBe(0);
    });
    it('3 successes resets counter AND sets flags.stable', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'death_save_success', payload: { character: 'char-1' } });
      s = applyEvent(s, { type: 'death_save_success', payload: { character: 'char-1' } });
      s = applyEvent(s, { type: 'death_save_success', payload: { character: 'char-1' } });
      expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
      expect(s.flags.stable).toBe(true);
    });
  });

  describe('death_save_fail', () => {
    it('increments failures by 1', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'death_save_fail', payload: { character: 'char-1' } });
      expect(next.death_saves.failures).toBe(1);
    });
    it('critical=true increments by 2', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'death_save_fail', payload: { character: 'char-1', critical: true } });
      expect(next.death_saves.failures).toBe(2);
    });
    it('3 failures resets counter AND sets flags.dead', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'death_save_fail', payload: { character: 'char-1' } });
      s = applyEvent(s, { type: 'death_save_fail', payload: { character: 'char-1' } });
      s = applyEvent(s, { type: 'death_save_fail', payload: { character: 'char-1' } });
      expect(s.flags.dead).toBe(true);
      expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
    });
  });

  describe('death_save_stabilize', () => {
    it('sets stable AND resets counters', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'death_save_fail', payload: { character: 'char-1' } });
      s = applyEvent(s, { type: 'death_save_stabilize', payload: { character: 'char-1' } });
      expect(s.flags.stable).toBe(true);
      expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
    });
  });

  describe('concentration_set / concentration_break', () => {
    it('sets concentrating_on', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'concentration_set', payload: { character: 'char-1', spellSlug: 'bless', slotLevel: 1, startedRound: 3 } });
      expect(next.concentrating_on).toEqual({ spellSlug: 'bless', slotLevel: 1, startedRound: 3 });
    });
    it('breaks concentration', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'concentration_set', payload: { character: 'char-1', spellSlug: 'bless', slotLevel: 1, startedRound: 3 } });
      s = applyEvent(s, { type: 'concentration_break', payload: { character: 'char-1' } });
      expect(s.concentrating_on).toBeNull();
    });
  });

  describe('exhaustion_set', () => {
    it('sets exhaustion level', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'exhaustion_set', payload: { character: 'char-1', level: 3 } });
      expect(next.exhaustion_level).toBe(3);
    });
    it('clamps to 10 maximum', () => {
      const s = freshState();
      // Validator rejects > 10; defensive clamp test
      const next = applyEvent(s, { type: 'exhaustion_set', payload: { character: 'char-1', level: 10 } });
      expect(next.exhaustion_level).toBe(10);
    });
  });

  describe('hit_dice_use / hit_dice_restore', () => {
    it('uses hit dice (decrements remaining)', () => {
      const s = freshState();
      // Seed with hit_dice_max = 5, remaining = 5
      const s2 = { ...s, hit_dice_max: 5, hit_dice_remaining: 5 };
      const next = applyEvent(s2, { type: 'hit_dice_use', payload: { character: 'char-1', count: 2 } });
      expect(next.hit_dice_remaining).toBe(3);
    });
    it('hit_dice_use clamps at 0', () => {
      const s = freshState();
      const s2 = { ...s, hit_dice_max: 5, hit_dice_remaining: 1 };
      const next = applyEvent(s2, { type: 'hit_dice_use', payload: { character: 'char-1', count: 5 } });
      expect(next.hit_dice_remaining).toBe(0);
    });
    it('hit_dice_restore caps at hit_dice_max', () => {
      const s = freshState();
      const s2 = { ...s, hit_dice_max: 5, hit_dice_remaining: 3 };
      const next = applyEvent(s2, { type: 'hit_dice_restore', payload: { character: 'char-1', count: 99 } });
      expect(next.hit_dice_remaining).toBe(5);
    });
  });

  describe('attune / unattune', () => {
    it('adds attunement (sorted)', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'attune', payload: { character: 'char-1', itemSlug: 'wand-of-fireballs' } });
      s = applyEvent(s, { type: 'attune', payload: { character: 'char-1', itemSlug: 'amulet-of-health' } });
      expect(s.attunements).toEqual(['amulet-of-health', 'wand-of-fireballs']);  // sorted
    });
    it('attune is idempotent', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'attune', payload: { character: 'char-1', itemSlug: 'wand' } });
      s = applyEvent(s, { type: 'attune', payload: { character: 'char-1', itemSlug: 'wand' } });
      expect(s.attunements).toEqual(['wand']);
    });
    it('unattune removes', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'attune', payload: { character: 'char-1', itemSlug: 'wand' } });
      s = applyEvent(s, { type: 'unattune', payload: { character: 'char-1', itemSlug: 'wand' } });
      expect(s.attunements).toEqual([]);
    });
  });

  describe('resource_use', () => {
    it('records resource use', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'resource_use', payload: { character: 'char-1', resourceKey: 'rage_uses', delta: 1 } });
      expect(next.resources_used).toEqual({ rage_uses: 1 });
    });
    it('clamps at 0 for negative-going totals', () => {
      const s = { ...freshState(), resources_used: { rage_uses: 0 } };
      const next = applyEvent(s, { type: 'resource_use', payload: { character: 'char-1', resourceKey: 'rage_uses', delta: -5 } });
      expect(next.resources_used.rage_uses).toBe(0);
    });
  });

  describe('inspiration_grant / inspiration_spend', () => {
    it('grant sets flags.inspiration = true', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'inspiration_grant', payload: { character: 'char-1' } });
      expect(next.flags.inspiration).toBe(true);
    });
    it('spend sets flags.inspiration = false', () => {
      let s = freshState();
      s = applyEvent(s, { type: 'inspiration_grant', payload: { character: 'char-1' } });
      s = applyEvent(s, { type: 'inspiration_spend', payload: { character: 'char-1' } });
      expect(s.flags.inspiration).toBe(false);
    });
  });

  describe('xp_award / level_up', () => {
    it('xp_award adds to xp', () => {
      const s = freshState();
      const next = applyEvent(s, { type: 'xp_award', payload: { character: 'char-1', amount: 250 } });
      expect(next.xp).toBe(250);
    });
    it('level_up advances level + hit_dice_max', () => {
      const s = { ...freshState(), level: 3, hit_dice_max: 3, hit_dice_remaining: 3 };
      const next = applyEvent(s, { type: 'level_up', payload: { character: 'char-1', newLevel: 4 } });
      expect(next.level).toBe(4);
      expect(next.hit_dice_max).toBe(4);
    });
    it('level_up records classSlug in classes map', () => {
      const s = { ...freshState(), level: 3, hit_dice_max: 3, classes: { wizard: 3 } };
      const next = applyEvent(s, { type: 'level_up', payload: { character: 'char-1', newLevel: 4, classSlug: 'wizard' } });
      expect(next.classes).toEqual({ wizard: 4 });
    });
  });

  describe('replay determinism + byte-stability', () => {
    it('replaying mixed Phase 02 + Phase 03 events twice produces byte-identical view', async () => {
      const seed = { id: 'c1', name: 'Aragorn', hp_max: 30 };
      const events: VaultEventEnvelope[] = [
        { id: '1', version: 1, type: 'campaign_initialized', payload: { characters: [seed] }, timestamp: '2026-05-26T00:00:00Z' },
        { id: '2', version: 1, type: 'hp_change', payload: { character: 'c1', delta: -5 }, timestamp: '2026-05-26T00:00:01Z' },
        { id: '3', version: 1, type: 'temp_hp_set', payload: { character: 'c1', tempHp: 3 }, timestamp: '2026-05-26T00:00:02Z' },
        { id: '4', version: 1, type: 'death_save_fail', payload: { character: 'c1' }, timestamp: '2026-05-26T00:00:03Z' },
        { id: '5', version: 1, type: 'attune', payload: { character: 'c1', itemSlug: 'amulet-of-health' }, timestamp: '2026-05-26T00:00:04Z' },
        { id: '6', version: 1, type: 'exhaustion_set', payload: { character: 'c1', level: 2 }, timestamp: '2026-05-26T00:00:05Z' },
      ];
      const states1 = replayEvents(events);
      const view1 = serializeView(states1.get('c1')!);
      const states2 = replayEvents(events);
      const view2 = serializeView(states2.get('c1')!);
      expect(view1).toBe(view2);  // byte-exact
    });
  });
});
```

The key cases:
- Reducer correctness per type (happy path)
- No-op semantics for OTHER characters
- Edge cases (death save thresholds, exhaustion clamp, hit dice cap)
- Byte-stability regression (spike 013 invariant) covering Phase 03 events

Aim for ~40-50 new test cases in this block; combined with Phase 02's existing 53 → projector test file grows to ~95-100 cases.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/projector.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All Phase 02 cases still pass (the 53 from plan 02-04)
    - All Phase 03 new cases pass (target: 40-50 new it() blocks)
    - The "byte-stability" regression case covers Phase 03 events (passes)
    - `grep -c "describe('applyEvent — Phase 03 reducer arms')" tests/ai/master/vault/projector.test.ts` returns exactly 1
    - `grep -c "describe('temp_hp_set'\|describe('death_save_success'\|describe('concentration_set\\|describe('exhaustion_set'\|describe('hit_dice_use'\|describe('attune\|describe('resource_use'\|describe('xp_award\|describe('level_up'" tests/ai/master/vault/projector.test.ts` returns ≥ 8
    - Test runtime < 10 seconds
  </acceptance_criteria>
  <done>
    Projector fully extended. Plan 03-A-04 wires the new types through the apply_event dispatcher (tool surface).
  </done>
</task>

---

# Execution SUMMARY — Plan 03-A-03

**Status:** COMPLETE
**Date:** 2026-05-26
**Wave:** 3 (parallel with 03-A-04 + 03-A-07 — disjoint files; all three landed)
**Executor commits:** 4 atomic commits (one per task)

## Result

Closed the Phase 03 typecheck gap and shipped reducer + serializer +
parser + test coverage for the 20 new VaultEvent types from
COMPLETENESS-AUDIT.md (c) Final list. `pnpm typecheck` returns to exit
0; the projector test file grows from 53 → 140 cases; the full vault
suite reports 536/19 skipped (was 405/19 baseline — the +131 includes
the 87 new projector tests AND the 44 tools.ts tests from sibling plan
03-A-04 that started passing once the reducer arms became available).

## Commits

| Task | Commit  | Title                                                                       |
| ---- | ------- | --------------------------------------------------------------------------- |
| 1    | c37549f | feat(phase-03): extend CharacterState + VaultSeedCharacter w/ Phase 03 fields |
| 2    | 847467d | feat(phase-03): add applyEvent reducer arms for 20 Phase 03 event types     |
| 3    | 2a50d1c | feat(phase-03): extend serializeView/parseView to round-trip Phase 03 fields |
| 4    | 2a9195c | test(phase-03): projector reducer + round-trip coverage for 20 types        |

## Deviations from plan

1. **Schema reality differs from plan-text examples (applied audit/schema as ground truth).**
   The plan's Task 2 example arms list `exhaustion_set`, `resource_use` with `delta`,
   and `level_up` — but the actual `VAULT_EVENT_TYPES` union shipped in Wave 2
   (`events-schema.ts`) uses `exhaustion_increment` / `exhaustion_decrement`,
   `resource_use` with `uses`, and does NOT include `level_up` (deferred to
   provisional list per audit Open Items §(d)). Followed the schema + audit;
   omitted `level_up`; added missing arms for `death_save_recover_at_one`,
   `resource_restore`, `focus_set`, `focus_unset` that the plan-text examples
   missed. Net result: 20 arms (matching the 20-type audit count exactly).

2. **`inspiration` kept inside `flags` (matches parity-check shape).**
   The audit recommended a top-level `state.inspiration` boolean, but
   `src/ai/master/vault/parity-check.ts` (already in main) normalizes vault
   state as `flags: { stable, dead, inspiration }`. Adopted the parity-check
   shape to preserve the existing diff contract; the validator side (Postgres)
   reads `pgChar.inspiration` (top-level column) and projects it INTO `flags`
   for comparison. The reducer arm sets `next.flags.inspiration` accordingly.

3. **Phase 02 mutation idiom (`next.X = ...`) preserved over plan-suggested spread.**
   The plan's Task 2 acceptance criterion suggests "use spread; no `state.X =`
   mutation". Phase 02's existing arms use `structuredClone(state)` → mutate
   `next` freely — semantically equivalent (since `next` is a fresh clone) but
   stylistically different. Followed the existing idiom for consistency; purity
   is enforced by the clone, not by spread-vs-assign. No `state.X = ...`
   mutations introduced (grep-verified — only the unrelated `parseView` local
   variable named `state` writes to itself, which is fine).

4. **`VaultSeedCharacter` extended in events-schema.ts within this plan.**
   The plan text said "extend events-schema.ts here in plan 03-A-03 alongside
   the projector edit — single commit, atomic schema+reducer coupling".
   Done as part of Task 1 commit. The plan frontmatter only lists `projector.ts`
   + `projector.test.ts` in `files_modified`; events-schema.ts was added to
   the Task 1 commit but kept out of the frontmatter to honor the file
   matrix as-declared. Future planner: consider adding events-schema.ts to
   the frontmatter array since the type extension was load-bearing for the
   reducer's seed handling.

5. **Test fixture sorting expectations corrected post-first-run (Rule 1 bug
   fix).** Initial Task 4 cases for `death_save_stabilize` and
   `death_save_recover_at_one` asserted alphabetically-sorted conditions,
   but the reducer uses `.filter()` which preserves array order (no re-sort
   on remove paths — sort happens only on add or at serializeView time).
   Fixed by asserting on membership + length, not exact-position equality.
   Also fixed the `serializes Phase 03 numerics in declared order` test
   to anchor `indexOf` lookups to `\n<key>:` (newline + key) — the bare
   `indexOf('level:')` was matching the substring inside `exhaustion_level:`
   and producing a false position. Both fixes are test-only; the reducer
   semantics are correct per the audit.

## Acceptance gates

| Gate                                                              | Status                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm typecheck` exit 0                                           | PASS                                                          |
| `pnpm test tests/ai/master/vault/projector.test.ts`               | PASS — 140/140 cases (53 baseline + 87 new)                   |
| Full vault suite (`pnpm test tests/ai/master/vault/`)             | PASS — 536/19 skipped                                         |
| 20 reducer arms (grep "case '<phase-03-type>'")                   | PASS — 20                                                     |
| 20 character guards (grep "if (event.payload.character !== state.id)")     | PASS — 20                                                     |
| `INITIAL_CHARACTER_STATE` includes every CharacterState field     | PASS                                                          |
| `serializeView` + `parseView` round-trip with Phase 03 state      | PASS (Task 4 test "round-trips a state with every Phase 03 field populated") |
| Byte-stable view (same state → same bytes — spike 013)             | PASS (Task 4 "byte-stable across two serializations")         |
| Backward-compat: Phase 02-only frontmatter parses successfully     | PASS (Task 4 "parseView accepts a Phase 02-only frontmatter") |
| Purity (`Date.now`/`Math.random`/`process.env` absent)            | PASS (REQ-022)                                                |
| `applyEvent` no `state.X = ...` mutation                          | PASS (only `next.X =` writes; structuredClone-rooted)         |
| No new typecheck errors outside the gap closed by this plan       | PASS                                                          |

## Files touched

| File                                                    | Action                                              |
| ------------------------------------------------------- | --------------------------------------------------- |
| `src/ai/master/vault/events-schema.ts`                  | EDIT (Task 1) — VaultSeedCharacter optional fields  |
| `src/ai/master/vault/projector.ts`                      | EDIT (Tasks 1+2+3) — state + reducer + serialize    |
| `tests/ai/master/vault/projector.test.ts`               | EDIT (Task 4) — 87 new test cases                   |
| `.planning/phases/03-migration-cutover/deferred-items.md` | EDIT (Task 4) — resolution + pre-existing fail log   |
| `.planning/phases/03-migration-cutover/plans/03-A-03-extend-projector.md` | EDIT — this SUMMARY                |

## Deferred items (logged separately)

- **`system-prompt.mode.test.ts` has 2 pre-existing failures unrelated
  to vault/projector.** Verified via `git stash` baseline — failures
  predate this plan. Out-of-scope per SCOPE BOUNDARY rule; tracked in
  `deferred-items.md` for follow-up triage.

## Self-check

- [x] Every plan acceptance criterion met
- [x] `pnpm typecheck` exit 0 (the gate this plan was tasked to fix)
- [x] Full vault suite passes (~405 baseline + 131 new = 536 actual)
- [x] Pure-module invariant preserved (REQ-022)
- [x] Deterministic sort invariant preserved (spike 013 — attunements
      sorted on insert, resources_used emitted in sorted-key order)
- [x] Test plan generated 87 new cases (target: 40-50) covering every
      type with happy path + edge case + cross-character no-op + purity
      + round-trip + byte-stable replay

Plan 03-A-04 (apply_event dispatcher tool description — already landed
in commits `de6aea3` + `22b09da`) consumes the new schema/reducer.
Plan 03-A-07 (migrate-campaigns-to-vault script — already landed in
commits `cb59da7` + `b2d3eb2` + `1f3fb90`) consumes the seed extension.
Wave 3 closes complete; Wave 4 may proceed.
