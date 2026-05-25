---
phase: 02
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/ai/master/vault/events-schema.ts
  - tests/ai/master/vault/events-schema.test.ts
autonomous: true
requirements: [REQ-005, REQ-010]
must_haves:
  truths:
    - "validateEvent returns ok:false for any malformed payload (missing field, wrong type, out-of-range numeric)"
    - "validateEvent returns ok:true with a strongly-typed VaultEvent for each of the 7 known event types"
    - "The 8th type campaign_initialized (seed event) validates with a payload listing characters and their initial state"
    - "An exhaustiveness check at the type level forces the projector to handle every union member or fail at tsc"
  artifacts:
    - path: "src/ai/master/vault/events-schema.ts"
      provides: "VaultEvent discriminated union + validateEvent + VAULT_EVENT_TYPES + EVENT_SCHEMA_VERSION"
      exports: ["VaultEvent", "VaultEventEnvelope", "validateEvent", "VAULT_EVENT_TYPES", "EVENT_SCHEMA_VERSION", "isVaultEventType"]
  key_links:
    - from: "src/ai/master/vault/events-schema.ts"
      to: "src/ai/master/vault/projector.ts (plan 02-04)"
      via: "shared VaultEvent type — exhaustive switch in applyEvent"
      pattern: "case '(hp_change|condition_add|condition_remove|spell_slot_use|spell_slot_restore|inventory_add|inventory_remove|campaign_initialized)'"
---

# Plan 02-01: Events Schema (Discriminated Union + Type Guards)

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 1 (no dependencies)
**Status:** Pending
**Estimated diff size:** ~120 LOC source + ~90 LOC tests / 2 files

## Goal

Ship the canonical event-type schema for Phase 02: a TypeScript discriminated union (`VaultEvent`) covering the 7 mutation events plus the 8th `campaign_initialized` seed event, with a runtime `validateEvent(input)` type guard that the `apply_event` dispatch branch (plan 02-07) uses at the LLM-→-server boundary.

Hand-rolled, no Zod dependency (per phase Decision 1 — `zod` is NOT in `package.json`, the validation surface is small enough that ~120 LOC of guards is more maintainable than a new runtime dep). The discriminated union pattern gives compile-time exhaustiveness in the projector: any new event type forces a tsc error in `applyEvent`'s `default:` branch unless explicitly handled.

The envelope wraps every event with `{id, version, type, payload, timestamp}` per spike 008 §"Decision-grade implications". `version` defaults to `EVENT_SCHEMA_VERSION = 1`; Phase 03 can bump and add migrations.

## Requirements satisfied

- **REQ-005** Mutations go through EventsWriter — this plan defines the SHAPE of every event the writer accepts. Plan 02-03 ships the writer; plan 02-07 wires the guard into the dispatcher.
- **REQ-010** 4-tool surface — this plan defines the schema for the 4th tool's payload.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/events-schema.ts` | NEW | `VaultEvent` discriminated union, `VaultEventEnvelope`, `validateEvent`, `VAULT_EVENT_TYPES`, `EVENT_SCHEMA_VERSION`, `isVaultEventType`. |
| `tests/ai/master/vault/events-schema.test.ts` | NEW | Vitest: happy-path validation per event type, rejection per malformed payload class, exhaustive type guard. |

## Tasks

<task type="auto">
  <name>Task 1: Create events-schema.ts with discriminated union + type guards</name>
  <files>src/ai/master/vault/events-schema.ts</files>
  <read_first>
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§6 Code Examples — "Hand-rolled event type guard")
    - .planning/spikes/008-events-md-replay/README.md (event envelope structure: id, version, type, payload, timestamp)
    - .claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md (lines 82-100 — the applyEvent reducer pattern that consumes this union)
    - src/ai/master/vault/path.ts (style reference — module-level JSDoc, named exports, no default exports)
    - src/ai/master/vault/tools.ts (style reference — REQ comments in JSDoc, ToolDef pattern)
  </read_first>
  <action>
Create `src/ai/master/vault/events-schema.ts` with the following exports (English JSDoc per CLAUDE.md):

1. **`EVENT_SCHEMA_VERSION` constant:** `export const EVENT_SCHEMA_VERSION = 1 as const;` — every event envelope carries this version; Phase 03 can bump and add migrations per spike 008 §"Decision-grade implications".

2. **`VAULT_EVENT_TYPES` const tuple:** `export const VAULT_EVENT_TYPES = ['hp_change', 'condition_add', 'condition_remove', 'spell_slot_use', 'spell_slot_restore', 'inventory_add', 'inventory_remove', 'campaign_initialized'] as const;` — the 7 mutation types + the seed event (per phase Decision 9).

3. **`VaultEventType` type:** `export type VaultEventType = typeof VAULT_EVENT_TYPES[number];`

4. **`isVaultEventType(value: unknown): value is VaultEventType` guard:** narrow `unknown` to the union by checking membership in `VAULT_EVENT_TYPES`. Used by the dispatcher (plan 02-07) before calling `validateEvent` so the error message can distinguish "unknown event type" from "malformed payload".

5. **`VaultEvent` discriminated union:** 8 members exactly matching RESEARCH §6 plus the seed:
   ```ts
   export type VaultEvent =
     | { type: 'hp_change'; payload: { character: string; delta: number } }
     | { type: 'condition_add'; payload: { character: string; condition: string } }
     | { type: 'condition_remove'; payload: { character: string; condition: string } }
     | { type: 'spell_slot_use'; payload: { character: string; level: number } }
     | { type: 'spell_slot_restore'; payload: { character: string; level: number } }
     | { type: 'inventory_add'; payload: { character: string; item: string; qty: number } }
     | { type: 'inventory_remove'; payload: { character: string; item: string; qty: number } }
     | { type: 'campaign_initialized'; payload: { characters: Array<{ id: string; name: string; hp_max: number; hp_current: number; spell_slots: Record<string, { max: number; used: number }> }> } };
   ```

6. **`VaultEventEnvelope` interface:** the on-disk shape — `{ id: string; version: typeof EVENT_SCHEMA_VERSION; type: VaultEventType; payload: VaultEvent['payload']; timestamp: string }`. The dispatcher constructs envelopes; the EventsWriter persists them; the projector reads them back. The `id` is a UUID (plan 02-07 calls `crypto.randomUUID()`); `timestamp` is ISO-8601 (`new Date().toISOString()` — note: timestamps are metadata only, not consumed by the pure projector per RESEARCH Pattern 2).

7. **`validateEvent(input: { type: string; payload: unknown }): { ok: true; value: VaultEvent } | { ok: false; error: string }`:** the runtime type guard. For each of the 8 types, validate:
   - **`hp_change`:** `typeof payload.character === 'string' && payload.character.length > 0` AND `typeof payload.delta === 'number' && Number.isFinite(payload.delta)`. The projector clamps to `[0, hp_max]` (per T-02-03 mitigation) — the schema does NOT bound `delta`.
   - **`condition_add` / `condition_remove`:** `typeof payload.character === 'string' && payload.character.length > 0` AND `typeof payload.condition === 'string' && payload.condition.length > 0`.
   - **`spell_slot_use` / `spell_slot_restore`:** `typeof payload.character === 'string'` AND `typeof payload.level === 'number' && Number.isInteger(payload.level) && payload.level >= 1 && payload.level <= 9` (D&D spell slot levels 1-9).
   - **`inventory_add` / `inventory_remove`:** `typeof payload.character === 'string'` AND `typeof payload.item === 'string' && payload.item.length > 0` AND `typeof payload.qty === 'number' && Number.isInteger(payload.qty) && payload.qty > 0 && payload.qty < 1000` (per T-02-03 mitigation — bounds payload size to prevent runaway state growth).
   - **`campaign_initialized`:** `Array.isArray(payload.characters) && payload.characters.every(c => typeof c.id === 'string' && typeof c.name === 'string' && typeof c.hp_max === 'number' && typeof c.hp_current === 'number' && typeof c.spell_slots === 'object')`. The seed event payload mirrors the Postgres characters table shape at the moment of flip.

   For ANY validation failure, return `{ ok: false, error: '<reason>' }` where `<reason>` is a human-readable string the LLM can use to self-correct (e.g., `'hp_change requires {character: string, delta: number}'`). On success, return `{ ok: true, value: <VaultEvent> }` with the value narrowed to the matching union member.

8. **Module-level JSDoc:** mirror the style of `src/ai/master/vault/tools.ts` — list REQs satisfied, cite Decision 1 + spike 008, document that the union is OPEN for extension via the projector's `default` case (Pitfall 6).

Use `const VAULT_EVENT_TYPES_SET = new Set<string>(VAULT_EVENT_TYPES);` for O(1) `isVaultEventType` lookup. Do NOT introduce any side effects, env reads, or imports beyond pure TypeScript (the file should be importable from a Vitest test that runs without DATABASE_URL — events-schema is pure logic).
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/events-schema.test.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File `src/ai/master/vault/events-schema.ts` exists and exports: `VaultEvent`, `VaultEventEnvelope`, `validateEvent`, `VAULT_EVENT_TYPES`, `EVENT_SCHEMA_VERSION`, `isVaultEventType`, `VaultEventType`
    - `grep -c "type: 'hp_change'" src/ai/master/vault/events-schema.ts` returns ≥ 1
    - `grep -c "type: 'campaign_initialized'" src/ai/master/vault/events-schema.ts` returns ≥ 1
    - `grep -c "import" src/ai/master/vault/events-schema.ts` returns 0 (no imports — pure logic per the read_first style reference path.ts has imports only from node builtins; events-schema has zero imports)
    - `pnpm typecheck` exits 0
    - `validateEvent({type: 'hp_change', payload: {character: 'aragorn', delta: -5}}).ok === true`
    - `validateEvent({type: 'hp_change', payload: {character: 'aragorn', delta: '5'}}).ok === false` (string delta rejected)
    - `validateEvent({type: 'unknown_type', payload: {}}).ok === false`
    - `validateEvent({type: 'spell_slot_use', payload: {character: 'aragorn', level: 10}}).ok === false` (level > 9 rejected)
    - `validateEvent({type: 'inventory_add', payload: {character: 'aragorn', item: 'rope', qty: 0}}).ok === false` (qty <= 0 rejected)
    - `EVENT_SCHEMA_VERSION === 1` and the constant is `as const` (preserves literal type narrowing)
  </acceptance_criteria>
  <done>
    File created with discriminated union, runtime guard, and version constant. `pnpm typecheck` passes. Used by plans 02-04 (projector consumes the union) and 02-07 (dispatcher consumes validateEvent).
  </done>
</task>

<task type="auto">
  <name>Task 2: Write events-schema.test.ts covering all 8 types + all rejection classes</name>
  <files>tests/ai/master/vault/events-schema.test.ts</files>
  <read_first>
    - src/ai/master/vault/events-schema.ts (the module under test — just created)
    - tests/ai/master/vault/tools.test.ts (style reference — describe/it blocks, expect.toEqual patterns)
    - tests/ai/master/vault/path.test.ts (style reference — type-narrowing assertions, no DATABASE_URL needed)
    - .planning/phases/01-vault-read-path/SUMMARY.md (line 51 — vitest scope rule, tests under tests/, NEVER colocated)
  </read_first>
  <action>
Create `tests/ai/master/vault/events-schema.test.ts` (Vitest, default `vitest.config.ts` discovery; the file MUST live under `tests/`, never colocated — per Phase 01 SUMMARY line 51).

Structure: one top-level `describe('events-schema', ...)` block with these nested describes:

1. **`describe('VAULT_EVENT_TYPES + isVaultEventType')`:**
   - `it('lists exactly the 8 known event types')` → `expect(VAULT_EVENT_TYPES).toHaveLength(8)` and `expect(new Set(VAULT_EVENT_TYPES)).toEqual(new Set(['hp_change', 'condition_add', 'condition_remove', 'spell_slot_use', 'spell_slot_restore', 'inventory_add', 'inventory_remove', 'campaign_initialized']))`
   - `it('isVaultEventType narrows known types')` → `expect(isVaultEventType('hp_change')).toBe(true)`, `expect(isVaultEventType('unknown')).toBe(false)`, `expect(isVaultEventType(123)).toBe(false)`, `expect(isVaultEventType(null)).toBe(false)`

2. **`describe('validateEvent — happy paths')`:** one `it` per event type. For each, build a minimal valid payload and assert `.ok === true` and `.value.type === <expected>` and `.value.payload === <expected>`. Example for `hp_change`:
   ```ts
   const r = validateEvent({ type: 'hp_change', payload: { character: 'aragorn', delta: -5 } });
   expect(r.ok).toBe(true);
   if (r.ok) {  // type narrowing
     expect(r.value.type).toBe('hp_change');
     expect(r.value.payload).toEqual({ character: 'aragorn', delta: -5 });
   }
   ```
   Cover all 8 types including `campaign_initialized` (build a minimal characters array with one character).

3. **`describe('validateEvent — rejection cases')`:** each `it` covers ONE failure mode:
   - Unknown type: `{type: 'level_up', payload: {}}` → `ok:false`, error contains `'unknown'` or `'level_up'`
   - Missing payload field: `{type: 'hp_change', payload: {character: 'aragorn'}}` (no delta) → `ok:false`
   - Wrong type in payload field: `{type: 'hp_change', payload: {character: 'aragorn', delta: '5'}}` (string instead of number) → `ok:false`
   - Empty character name: `{type: 'hp_change', payload: {character: '', delta: 5}}` → `ok:false`
   - Non-finite delta: `{type: 'hp_change', payload: {character: 'aragorn', delta: NaN}}` → `ok:false`
   - Non-finite delta (infinity): `{type: 'hp_change', payload: {character: 'aragorn', delta: Infinity}}` → `ok:false`
   - Spell slot level out of range (>9): `{type: 'spell_slot_use', payload: {character: 'aragorn', level: 10}}` → `ok:false`
   - Spell slot level out of range (<1): `{type: 'spell_slot_use', payload: {character: 'aragorn', level: 0}}` → `ok:false`
   - Spell slot level non-integer: `{type: 'spell_slot_use', payload: {character: 'aragorn', level: 2.5}}` → `ok:false`
   - Inventory qty zero: `{type: 'inventory_add', payload: {character: 'aragorn', item: 'rope', qty: 0}}` → `ok:false`
   - Inventory qty negative: `{type: 'inventory_add', payload: {character: 'aragorn', item: 'rope', qty: -1}}` → `ok:false`
   - Inventory qty >= 1000: `{type: 'inventory_add', payload: {character: 'aragorn', item: 'rope', qty: 1000}}` → `ok:false`
   - Inventory empty item: `{type: 'inventory_add', payload: {character: 'aragorn', item: '', qty: 5}}` → `ok:false`
   - `campaign_initialized` with non-array characters: `{type: 'campaign_initialized', payload: {characters: 'foo'}}` → `ok:false`
   - Payload not an object: `{type: 'hp_change', payload: 'not an object'}` → `ok:false`
   - Payload null: `{type: 'hp_change', payload: null}` → `ok:false`

4. **`describe('VaultEventEnvelope shape')`:** one `it` validating that `EVENT_SCHEMA_VERSION === 1` and that the literal-type narrowing holds (a type-only assertion via a typed const, e.g., `const v: typeof EVENT_SCHEMA_VERSION = 1; expect(v).toBe(1);`).

5. **No DATABASE_URL required:** the test file imports ONLY from `src/ai/master/vault/events-schema.ts`. Verify by running `pnpm test tests/ai/master/vault/events-schema.test.ts` with `DATABASE_URL` UNSET in the env — must pass.

6. Total: 4 describe blocks, ~30 `it` cases (1 listing + 2 narrowing + 8 happy paths + ~17 rejection cases + 1 version shape).
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/events-schema.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~30 test cases pass
    - `grep -c "validateEvent" tests/ai/master/vault/events-schema.test.ts` returns ≥ 25 (one per case)
    - `grep -c "campaign_initialized" tests/ai/master/vault/events-schema.test.ts` returns ≥ 2 (happy path + rejection)
    - Test file does NOT import from `@/db/` or `@/lib/preferences` (no DATABASE_URL dependency)
    - Running `unset DATABASE_URL; pnpm test tests/ai/master/vault/events-schema.test.ts` exits 0
  </acceptance_criteria>
  <done>
    Tests exist and pass. Coverage: 8 happy paths + ~17 rejection classes + tuple/version invariants. Plan 02-04 (projector) and plan 02-07 (dispatcher) consume this guard.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/ai/master/vault/events-schema.test.ts` → all cases pass
- Command: `pnpm typecheck` → clean (discriminated union compiles, no `any`)
- Behaviour: `pnpm exec tsx -e "import {validateEvent} from './src/ai/master/vault/events-schema.ts'; console.log(JSON.stringify(validateEvent({type:'hp_change',payload:{character:'aragorn',delta:-5}})))"` prints `{"ok":true,"value":{"type":"hp_change","payload":{"character":"aragorn","delta":-5}}}`
- Grep gate: `grep -v '^ *\*' src/ai/master/vault/events-schema.ts | grep -v '^ *//' | grep -c "case '"` returns ≥ 8 (one switch arm per type — comments and JSDoc filtered out so the count reflects real code).

## Open questions

None — the discriminated union pattern is locked by Decision 1; the 7 mutation types + seed event are explicitly enumerated in RESEARCH §A5 and Decision 9.
