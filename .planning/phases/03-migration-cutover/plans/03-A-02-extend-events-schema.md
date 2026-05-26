---
phase: 03
plan: A-02
type: execute
wave: 2
depends_on: [03-A-01]
files_modified:
  - src/ai/master/vault/events-schema.ts
  - tests/ai/master/vault/events-schema.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "VAULT_EVENT_TYPES tuple now includes every event type from the (c) Final list in COMPLETENESS-AUDIT.md"
    - "The VaultEvent discriminated union has a new arm for each (c) event type, with the typed payload shape specified in the audit"
    - "validateEvent has a new case arm for each (c) event type that returns ok:true on valid input and ok:false with a descriptive error on malformed input"
    - "isVaultEventType returns true for every new event type string from the audit"
    - "EVENT_SCHEMA_VERSION is unchanged at 1 — the additions are additive, not breaking (Phase 02 graceful-degradation default arm absorbs them safely for in-flight events.md files)"
    - "All existing Phase 02 union members (hp_change, condition_add, ..., campaign_initialized) remain unchanged"
  artifacts:
    - path: "src/ai/master/vault/events-schema.ts"
      provides: "Extended VAULT_EVENT_TYPES + VaultEvent union + validateEvent dispatcher with the (c) Final list entries"
      contains: "VAULT_EVENT_TYPES"
    - path: "tests/ai/master/vault/events-schema.test.ts"
      provides: "Valid + invalid payload cases for every new event type"
  key_links:
    - from: "src/ai/master/vault/events-schema.ts (new union members)"
      to: ".planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (c) Final list"
      via: "Each new member matches the audit row 1:1 (name, payload shape, validation rules)"
      pattern: "temp_hp_set|death_save_|concentration_|exhaustion_set|hit_dice_|attune|unattune|resource_use|inspiration_|xp_award|level_up"
    - from: "src/ai/master/vault/projector.ts (plan 03-A-03)"
      to: "src/ai/master/vault/events-schema.ts (this plan)"
      via: "Reducer arms consume the new VaultEvent union members; tsc enforces exhaustiveness"
      pattern: "VaultEvent"
---

# Plan 03-A-02: Extend events-schema.ts with New Event Types

**Phase:** 03-migration-cutover
**Wave:** 2 (depends on 03-A-01 audit output)
**Status:** Pending
**Estimated diff size:** ~250 LOC source + ~200 LOC tests / 2 files

## Goal

Take the (c) Final list from plan 03-A-01's `COMPLETENESS-AUDIT.md` and ship each new event type as an additive extension to Phase 02's `VaultEvent` discriminated union. Mirror the EXACT pattern Phase 02 used for the 8 existing types: const tuple entry → union member → validator case → test cases.

The additions are ADDITIVE — no Phase 02 union members are modified, no migration is needed for in-flight events.md files (Phase 02's projector default arm absorbs unknown event types per Pitfall 6 graceful degradation; Phase 03's new types are subsequently understood once 03-A-03 ships the reducer arms).

`EVENT_SCHEMA_VERSION` stays at 1 — the version bump convention is for INCOMPATIBLE payload changes (e.g., adding a required field to an existing event type), not for new event types.

## Requirements satisfied

- **REQ-006** DR via events.md replay — events.md becomes a complete record of every persisted mutation only AFTER this plan ships the new types. Without 03-A-02 + 03-A-03, replay produces incomplete state.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/events-schema.ts` | EDIT (additive) | Extend `VAULT_EVENT_TYPES` tuple + `VaultEvent` union + `validateEvent` switch arms |
| `tests/ai/master/vault/events-schema.test.ts` | EDIT (additive) | Add valid + invalid payload cases per new type |

## Tasks

<task type="auto">
  <name>Task 1: Extend VAULT_EVENT_TYPES + VaultEvent union with the (c) list</name>
  <files>src/ai/master/vault/events-schema.ts</files>
  <read_first>
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (the (c) Final list — authoritative)
    - src/ai/master/vault/events-schema.ts (existing — lines 76-85 VAULT_EVENT_TYPES const tuple; lines 149-157 VaultEvent union; lines 228-end validateEvent switch)
    - .planning/phases/02-vault-write-path-event-sourcing/plans/02-01-events-schema.md (the original schema plan — mirror its idioms and validation style)
  </read_first>
  <action>
Edit `src/ai/master/vault/events-schema.ts` (preserve everything else verbatim). Three additive changes per (c) entry in the audit.

**Change 1 — Extend `VAULT_EVENT_TYPES` const tuple.** Locate the existing array (lines 76-85). The order is: Phase 02 types first (unchanged), then Phase 03 additions appended in the order they appear in the audit's (c) Final list.

Replace the array with:
```ts
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
  // Phase 03 (new — from COMPLETENESS-AUDIT.md (c) Final list)
  'temp_hp_set',
  'death_save_success',
  'death_save_fail',
  'death_save_stabilize',
  'concentration_break',
  'concentration_set',
  'exhaustion_set',
  'hit_dice_use',
  'hit_dice_restore',
  'attune',
  'unattune',
  'resource_use',
  'inspiration_grant',
  'inspiration_spend',
  'xp_award',
  'level_up',
] as const;
```

(The exact set comes from the audit — if the audit found 10 instead of 16, use those 10 exactly. The above is the RESEARCH estimate; the audit is authoritative.)

**Change 2 — Extend `VaultEvent` discriminated union.** Locate the union (line 149-157). Append new arms after the Phase 02 entries:

```ts
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
  // Phase 03 (new — see COMPLETENESS-AUDIT.md)
  | { type: 'temp_hp_set'; payload: { character: string; tempHp: number } }
  | { type: 'death_save_success'; payload: { character: string } }
  | { type: 'death_save_fail'; payload: { character: string; critical?: boolean } }
  | { type: 'death_save_stabilize'; payload: { character: string } }
  | { type: 'concentration_break'; payload: { character: string } }
  | { type: 'concentration_set'; payload: { character: string; spellSlug: string; slotLevel: number; startedRound: number } }
  | { type: 'exhaustion_set'; payload: { character: string; level: number } }
  | { type: 'hit_dice_use'; payload: { character: string; count: number } }
  | { type: 'hit_dice_restore'; payload: { character: string; count: number } }
  | { type: 'attune'; payload: { character: string; itemSlug: string } }
  | { type: 'unattune'; payload: { character: string; itemSlug: string } }
  | { type: 'resource_use'; payload: { character: string; resourceKey: string; delta: number } }
  | { type: 'inspiration_grant'; payload: { character: string } }
  | { type: 'inspiration_spend'; payload: { character: string } }
  | { type: 'xp_award'; payload: { character: string; amount: number } }
  | { type: 'level_up'; payload: { character: string; newLevel: number; classSlug?: string } };
```

Match the audit row-by-row. If the audit specifies a different payload shape (e.g., death_save_fail without `critical`), use the audit's shape.

**Change 3 — Update module JSDoc.** Locate the file-level JSDoc at the top (lines 1-59). Add a "Phase 03 extension" subsection AFTER the existing "Seed event — Decision 9:" block:

```ts
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
```

Do NOT change `EVENT_SCHEMA_VERSION` — it stays at `1`.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/events-schema.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "^\s*'[a-z_]*',$" src/ai/master/vault/events-schema.ts` returns ≥ 16 (8 Phase 02 + at least 8 Phase 03 entries in VAULT_EVENT_TYPES)
    - `grep -c "type: 'temp_hp_set'\|type: 'death_save_success'\|type: 'concentration_break'" src/ai/master/vault/events-schema.ts` returns ≥ 3 (representative new union arms)
    - `grep "EVENT_SCHEMA_VERSION = 1" src/ai/master/vault/events-schema.ts` returns 1 line (version unchanged)
    - Every entry in the audit's (c) Final list appears as a new VaultEvent union arm
    - The existing Phase 02 8 union members are present and unchanged
  </acceptance_criteria>
  <done>
    Schema extended. validateEvent (Task 2) and projector (plan 03-A-03) consume the new types.
  </done>
</task>

<task type="auto">
  <name>Task 2: Extend validateEvent with new switch arms</name>
  <files>src/ai/master/vault/events-schema.ts</files>
  <read_first>
    - src/ai/master/vault/events-schema.ts (Task 1 — VaultEvent union now extended; existing validateEvent lines 228+; the per-type validation idioms — typeof checks, length > 0 checks, Number.isFinite for numbers, integer-range checks for levels)
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (validator rules per new event type)
  </read_first>
  <action>
Edit `src/ai/master/vault/events-schema.ts`. Extend `validateEvent` switch (after the Phase 02 `campaign_initialized` case, BEFORE the `default` arm):

For EACH new event type from Task 1, add a case block that:
1. Validates `payload.character` is a non-empty string
2. Validates the type-specific payload fields per the audit
3. Returns `{ ok: true, value: { type: 'X', payload: {...} } }` on success
4. Returns `{ ok: false, error: '<descriptive>' }` on failure

Concrete snippets (adapt to audit's actual shapes):

```ts
    case 'temp_hp_set': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'temp_hp_set requires {character: non-empty string, tempHp: number >= 0}' };
      }
      if (typeof p.tempHp !== 'number' || !Number.isFinite(p.tempHp) || p.tempHp < 0) {
        return { ok: false, error: 'temp_hp_set requires {character: non-empty string, tempHp: number >= 0}' };
      }
      return { ok: true, value: { type: 'temp_hp_set', payload: { character: p.character, tempHp: p.tempHp } } };
    }
    case 'death_save_success': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_success requires {character: non-empty string}' };
      }
      return { ok: true, value: { type: 'death_save_success', payload: { character: p.character } } };
    }
    case 'death_save_fail': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_fail requires {character: non-empty string, critical?: boolean}' };
      }
      const critical = p.critical;
      if (critical !== undefined && typeof critical !== 'boolean') {
        return { ok: false, error: 'death_save_fail.critical must be boolean if provided' };
      }
      return { ok: true, value: { type: 'death_save_fail', payload: { character: p.character, ...(critical !== undefined ? { critical } : {}) } } };
    }
    case 'death_save_stabilize': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'death_save_stabilize requires {character: non-empty string}' };
      }
      return { ok: true, value: { type: 'death_save_stabilize', payload: { character: p.character } } };
    }
    case 'concentration_break': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: 'concentration_break requires {character: non-empty string}' };
      }
      return { ok: true, value: { type: 'concentration_break', payload: { character: p.character } } };
    }
    case 'concentration_set': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.spellSlug !== 'string' || p.spellSlug.length === 0 ||
          typeof p.slotLevel !== 'number' || !Number.isInteger(p.slotLevel) || p.slotLevel < 1 || p.slotLevel > 9 ||
          typeof p.startedRound !== 'number' || !Number.isInteger(p.startedRound) || p.startedRound < 0) {
        return { ok: false, error: 'concentration_set requires {character: non-empty string, spellSlug: non-empty string, slotLevel: integer 1-9, startedRound: integer >= 0}' };
      }
      return { ok: true, value: { type: 'concentration_set', payload: { character: p.character, spellSlug: p.spellSlug, slotLevel: p.slotLevel, startedRound: p.startedRound } } };
    }
    case 'exhaustion_set': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.level !== 'number' || !Number.isInteger(p.level) || p.level < 0 || p.level > 10) {
        return { ok: false, error: 'exhaustion_set requires {character: non-empty string, level: integer 0-10}' };
      }
      return { ok: true, value: { type: 'exhaustion_set', payload: { character: p.character, level: p.level } } };
    }
    case 'hit_dice_use':
    case 'hit_dice_restore': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count <= 0 || p.count > 50) {
        return { ok: false, error: `${input.type} requires {character: non-empty string, count: integer 1-50}` };
      }
      return { ok: true, value: { type: input.type, payload: { character: p.character, count: p.count } } as VaultEvent };
    }
    case 'attune':
    case 'unattune': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.itemSlug !== 'string' || p.itemSlug.length === 0) {
        return { ok: false, error: `${input.type} requires {character: non-empty string, itemSlug: non-empty string}` };
      }
      return { ok: true, value: { type: input.type, payload: { character: p.character, itemSlug: p.itemSlug } } as VaultEvent };
    }
    case 'resource_use': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.resourceKey !== 'string' || p.resourceKey.length === 0 ||
          typeof p.delta !== 'number' || !Number.isInteger(p.delta)) {
        return { ok: false, error: 'resource_use requires {character: non-empty string, resourceKey: non-empty string, delta: integer}' };
      }
      return { ok: true, value: { type: 'resource_use', payload: { character: p.character, resourceKey: p.resourceKey, delta: p.delta } } };
    }
    case 'inspiration_grant':
    case 'inspiration_spend': {
      if (typeof p.character !== 'string' || p.character.length === 0) {
        return { ok: false, error: `${input.type} requires {character: non-empty string}` };
      }
      return { ok: true, value: { type: input.type, payload: { character: p.character } } as VaultEvent };
    }
    case 'xp_award': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.amount !== 'number' || !Number.isInteger(p.amount) || p.amount <= 0 || p.amount > 1_000_000) {
        return { ok: false, error: 'xp_award requires {character: non-empty string, amount: positive integer < 1,000,000}' };
      }
      return { ok: true, value: { type: 'xp_award', payload: { character: p.character, amount: p.amount } } };
    }
    case 'level_up': {
      if (typeof p.character !== 'string' || p.character.length === 0 ||
          typeof p.newLevel !== 'number' || !Number.isInteger(p.newLevel) || p.newLevel < 1 || p.newLevel > 20) {
        return { ok: false, error: 'level_up requires {character: non-empty string, newLevel: integer 1-20, classSlug?: string}' };
      }
      const classSlug = p.classSlug;
      if (classSlug !== undefined && (typeof classSlug !== 'string' || classSlug.length === 0)) {
        return { ok: false, error: 'level_up.classSlug must be a non-empty string if provided' };
      }
      return { ok: true, value: { type: 'level_up', payload: { character: p.character, newLevel: p.newLevel, ...(classSlug ? { classSlug } : {}) } } };
    }
```

Place these AFTER the `case 'campaign_initialized':` arm and BEFORE the `default:` arm.

Run `pnpm typecheck` after the edits to confirm:
- The exhaustiveness check in the projector (plan 03-A-03 will UPDATE that one too) is still satisfied at the schema level (i.e., the `default:` here returns `{ ok: false, error: unreachable }` via the `never` type — see Phase 02 implementation)
- Every union member has a validator arm
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "case 'temp_hp_set'\|case 'death_save_success'\|case 'death_save_fail'\|case 'death_save_stabilize'\|case 'concentration_break'\|case 'concentration_set'\|case 'exhaustion_set'\|case 'hit_dice_use'\|case 'hit_dice_restore'\|case 'attune'\|case 'unattune'\|case 'resource_use'\|case 'inspiration_grant'\|case 'inspiration_spend'\|case 'xp_award'\|case 'level_up'" src/ai/master/vault/events-schema.ts` returns ≥ 14 (each new arm — could be fewer if audit found fewer; verify against audit count)
    - Every (c) entry from COMPLETENESS-AUDIT.md has a corresponding `case 'X':` arm in validateEvent
    - No existing Phase 02 case arms are modified (`grep -c "case 'hp_change'\|case 'condition_add'\|case 'campaign_initialized'" src/ai/master/vault/events-schema.ts` returns 3 — Phase 02 arms untouched)
  </acceptance_criteria>
  <done>
    Validator extended. Task 3 adds the tests.
  </done>
</task>

<task type="auto">
  <name>Task 3: Extend events-schema.test.ts with cases for every new event type</name>
  <files>tests/ai/master/vault/events-schema.test.ts</files>
  <read_first>
    - tests/ai/master/vault/events-schema.test.ts (existing Phase 02 cases — the `describe('validateEvent — <type>')` pattern, the success-vs-error case structure)
    - src/ai/master/vault/events-schema.ts (Tasks 1+2 — the new arms)
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (the (c) Final list — payload edge cases per type)
  </read_first>
  <action>
Append a new top-level `describe('validateEvent — Phase 03 additions')` block to `tests/ai/master/vault/events-schema.test.ts`. Preserve all Phase 02 cases verbatim.

For EACH new event type, add a nested describe with at least 3 cases:
1. Happy path — valid input returns `{ ok: true, value: ... }`
2. Missing/malformed character field
3. Missing/malformed type-specific field
4. (where applicable) Out-of-range numeric field

Concrete structure:

```ts
describe('validateEvent — Phase 03 additions', () => {
  describe('temp_hp_set', () => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type: 'temp_hp_set', payload: { character: 'char-1', tempHp: 5 } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ type: 'temp_hp_set', payload: { character: 'char-1', tempHp: 5 } });
    });
    it('accepts tempHp = 0 (reset)', () => {
      const r = validateEvent({ type: 'temp_hp_set', payload: { character: 'char-1', tempHp: 0 } });
      expect(r.ok).toBe(true);
    });
    it('rejects negative tempHp', () => {
      const r = validateEvent({ type: 'temp_hp_set', payload: { character: 'char-1', tempHp: -1 } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/tempHp/i);
    });
    it('rejects missing character', () => {
      const r = validateEvent({ type: 'temp_hp_set', payload: { tempHp: 5 } });
      expect(r.ok).toBe(false);
    });
    it('rejects non-numeric tempHp', () => {
      const r = validateEvent({ type: 'temp_hp_set', payload: { character: 'c', tempHp: 'five' as unknown as number } });
      expect(r.ok).toBe(false);
    });
  });

  describe('death_save_success', () => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type: 'death_save_success', payload: { character: 'char-1' } });
      expect(r.ok).toBe(true);
    });
    it('rejects empty character', () => {
      const r = validateEvent({ type: 'death_save_success', payload: { character: '' } });
      expect(r.ok).toBe(false);
    });
    it('rejects missing character', () => {
      const r = validateEvent({ type: 'death_save_success', payload: {} });
      expect(r.ok).toBe(false);
    });
  });

  describe('death_save_fail', () => {
    it('accepts valid payload without critical', () => {
      const r = validateEvent({ type: 'death_save_fail', payload: { character: 'char-1' } });
      expect(r.ok).toBe(true);
    });
    it('accepts valid payload with critical: true', () => {
      const r = validateEvent({ type: 'death_save_fail', payload: { character: 'char-1', critical: true } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.payload).toHaveProperty('critical', true);
    });
    it('rejects non-boolean critical', () => {
      const r = validateEvent({ type: 'death_save_fail', payload: { character: 'c', critical: 'yes' as unknown as boolean } });
      expect(r.ok).toBe(false);
    });
  });

  describe('death_save_stabilize', () => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type: 'death_save_stabilize', payload: { character: 'char-1' } });
      expect(r.ok).toBe(true);
    });
  });

  describe('concentration_break', () => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type: 'concentration_break', payload: { character: 'char-1' } });
      expect(r.ok).toBe(true);
    });
  });

  describe('concentration_set', () => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type: 'concentration_set', payload: { character: 'c', spellSlug: 'bless', slotLevel: 1, startedRound: 3 } });
      expect(r.ok).toBe(true);
    });
    it('rejects slotLevel out of range', () => {
      const r = validateEvent({ type: 'concentration_set', payload: { character: 'c', spellSlug: 'wish', slotLevel: 10, startedRound: 1 } });
      expect(r.ok).toBe(false);
    });
    it('rejects negative startedRound', () => {
      const r = validateEvent({ type: 'concentration_set', payload: { character: 'c', spellSlug: 'bless', slotLevel: 1, startedRound: -1 } });
      expect(r.ok).toBe(false);
    });
  });

  describe('exhaustion_set', () => {
    it('accepts level 0', () => {
      const r = validateEvent({ type: 'exhaustion_set', payload: { character: 'c', level: 0 } });
      expect(r.ok).toBe(true);
    });
    it('accepts level 10', () => {
      const r = validateEvent({ type: 'exhaustion_set', payload: { character: 'c', level: 10 } });
      expect(r.ok).toBe(true);
    });
    it('rejects level 11', () => {
      const r = validateEvent({ type: 'exhaustion_set', payload: { character: 'c', level: 11 } });
      expect(r.ok).toBe(false);
    });
    it('rejects negative level', () => {
      const r = validateEvent({ type: 'exhaustion_set', payload: { character: 'c', level: -1 } });
      expect(r.ok).toBe(false);
    });
  });

  describe.each(['hit_dice_use', 'hit_dice_restore'] as const)('%s', (type) => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type, payload: { character: 'c', count: 3 } });
      expect(r.ok).toBe(true);
    });
    it('rejects count = 0', () => {
      const r = validateEvent({ type, payload: { character: 'c', count: 0 } });
      expect(r.ok).toBe(false);
    });
    it('rejects count > 50', () => {
      const r = validateEvent({ type, payload: { character: 'c', count: 51 } });
      expect(r.ok).toBe(false);
    });
  });

  describe.each(['attune', 'unattune'] as const)('%s', (type) => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type, payload: { character: 'c', itemSlug: 'ring-of-protection' } });
      expect(r.ok).toBe(true);
    });
    it('rejects empty itemSlug', () => {
      const r = validateEvent({ type, payload: { character: 'c', itemSlug: '' } });
      expect(r.ok).toBe(false);
    });
  });

  describe('resource_use', () => {
    it('accepts positive delta', () => {
      const r = validateEvent({ type: 'resource_use', payload: { character: 'c', resourceKey: 'rage_uses', delta: 1 } });
      expect(r.ok).toBe(true);
    });
    it('accepts negative delta (restore)', () => {
      const r = validateEvent({ type: 'resource_use', payload: { character: 'c', resourceKey: 'rage_uses', delta: -1 } });
      expect(r.ok).toBe(true);
    });
    it('rejects non-integer delta', () => {
      const r = validateEvent({ type: 'resource_use', payload: { character: 'c', resourceKey: 'k', delta: 1.5 } });
      expect(r.ok).toBe(false);
    });
  });

  describe.each(['inspiration_grant', 'inspiration_spend'] as const)('%s', (type) => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type, payload: { character: 'c' } });
      expect(r.ok).toBe(true);
    });
  });

  describe('xp_award', () => {
    it('accepts valid payload', () => {
      const r = validateEvent({ type: 'xp_award', payload: { character: 'c', amount: 250 } });
      expect(r.ok).toBe(true);
    });
    it('rejects zero amount', () => {
      const r = validateEvent({ type: 'xp_award', payload: { character: 'c', amount: 0 } });
      expect(r.ok).toBe(false);
    });
    it('rejects amount over cap', () => {
      const r = validateEvent({ type: 'xp_award', payload: { character: 'c', amount: 1_000_001 } });
      expect(r.ok).toBe(false);
    });
  });

  describe('level_up', () => {
    it('accepts valid payload without classSlug', () => {
      const r = validateEvent({ type: 'level_up', payload: { character: 'c', newLevel: 5 } });
      expect(r.ok).toBe(true);
    });
    it('accepts valid payload with classSlug', () => {
      const r = validateEvent({ type: 'level_up', payload: { character: 'c', newLevel: 5, classSlug: 'wizard' } });
      expect(r.ok).toBe(true);
    });
    it('rejects newLevel = 0', () => {
      const r = validateEvent({ type: 'level_up', payload: { character: 'c', newLevel: 0 } });
      expect(r.ok).toBe(false);
    });
    it('rejects newLevel > 20', () => {
      const r = validateEvent({ type: 'level_up', payload: { character: 'c', newLevel: 21 } });
      expect(r.ok).toBe(false);
    });
  });
});
```

Adjust the test set to match the actual (c) list from the audit — every new event type MUST have at least 1 success + 2 failure cases.

Also add an "Integration: VAULT_EVENT_TYPES contains all Phase 03 additions" assertion at the top of the new describe:

```ts
it('VAULT_EVENT_TYPES contains every Phase 03 addition', () => {
  expect(VAULT_EVENT_TYPES).toContain('temp_hp_set');
  expect(VAULT_EVENT_TYPES).toContain('death_save_success');
  expect(VAULT_EVENT_TYPES).toContain('death_save_fail');
  // ... etc, every entry from the audit's (c) Final list
});
```

And:

```ts
it('isVaultEventType returns true for every Phase 03 addition', () => {
  ['temp_hp_set', 'death_save_success', 'death_save_fail', 'death_save_stabilize',
    'concentration_break', 'concentration_set', 'exhaustion_set',
    'hit_dice_use', 'hit_dice_restore', 'attune', 'unattune',
    'resource_use', 'inspiration_grant', 'inspiration_spend',
    'xp_award', 'level_up'].forEach((t) => {
    expect(isVaultEventType(t)).toBe(true);
  });
});
```
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/events-schema.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All Phase 02 cases still pass (the original 50 cases unchanged)
    - All Phase 03 new cases pass — at least 3 cases per new event type
    - `grep -c "describe('validateEvent — Phase 03 additions')" tests/ai/master/vault/events-schema.test.ts` returns exactly 1
    - `grep -c "describe\\.each\\|describe('temp_hp_set'\\|describe('death_save_" tests/ai/master/vault/events-schema.test.ts` returns ≥ 8 (representative new describes)
    - Test runtime stays well under 10s (these are pure unit tests, no I/O)
  </acceptance_criteria>
  <done>
    Schema fully extended + validated. Plan 03-A-03 ships the projector reducer arms.
  </done>
</task>
