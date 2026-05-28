---
phase: 06-vault-combat-state-foundation-d1
plan: "01"
subsystem: vault-projector
tags: [combat, event-sourcing, projector, reducer, tdd]
dependency_graph:
  requires: []
  provides:
    - "EncounterState type + INITIAL_ENCOUNTER_STATE in projector.ts"
    - "applyEncounterEvent pure reducer (all 6 LOCKED event effects)"
    - "replayEvents returns { chars, encounter } (additive — chars semantics unchanged)"
    - "serializeCombatView: byte-stable YAML frontmatter for combat.md"
    - "regenerateCombatView: async disk write of combat.md"
    - "regenerateAffectedViews extended: ENCOUNTER_EVENT_TYPES routed to regenerateCombatView"
    - "ENCOUNTER_EVENT_TYPES exported from events-schema.ts (O(1) routing set)"
    - "validateEvent armed for all 6 encounter types (no payload.character check)"
  affects:
    - "src/sessions/event-to-engine-mutation.ts (no-op arms for encounter events)"
    - "scripts/vault-rebuild-views.ts (replayEvents caller updated)"
    - "src/ai/master/vault/parity-check.ts (replayEvents caller updated)"
    - "src/ai/master/vault/snapshot-reader.ts (replayEvents caller updated)"
tech_stack:
  added: []
  patterns:
    - "structuredClone immutability discipline in applyEncounterEvent (mirrors applyEvent)"
    - "ENCOUNTER_EVENT_TYPES.has() for O(1) routing in replayEvents + regenerateAffectedViews"
    - "hand-rolled YAML emitter in serializeCombatView (no yaml dep, byte-stable)"
key_files:
  created:
    - "tests/ai/master/vault/combat-reducer.test.ts"
  modified:
    - "src/ai/master/vault/events-schema.ts"
    - "src/ai/master/vault/projector.ts"
    - "src/sessions/event-to-engine-mutation.ts"
    - "scripts/vault-rebuild-views.ts"
    - "src/ai/master/vault/parity-check.ts"
    - "src/ai/master/vault/snapshot-reader.ts"
    - "tests/ai/master/vault/events-schema.test.ts"
    - "tests/ai/master/vault/projector.test.ts"
    - "tests/ai/master/vault/apply-event-integration.test.ts"
    - "tests/sessions/vault-mutations-resume.test.ts"
decisions:
  - "replayEvents return type changed from Map<string,CharacterState> to { chars, encounter } — single-pass through event log, both reducers run concurrently; ENCOUNTER_EVENT_TYPES.has() routes to encounter reducer and returns early (no payload.character lookup)"
  - "applyEncounterEvent default arm returns state (not never-typed) — reducer is not exhaustive over all VaultEvent members, only the 6 encounter types; no throw on non-encounter events"
  - "serializeCombatView emits minimal frontmatter (active: false only) when not in combat — avoids stale data in the file"
  - "event-to-engine-mutation.ts encounter arms are no-ops — REQ-037 prohibits Postgres combat writes in D1"
metrics:
  duration_seconds: 755
  tasks_completed: 2
  files_modified: 10
  files_created: 1
  completed_date: "2026-05-28"
---

# Phase 6 Plan 1: Vault Combat State Foundation D1 Summary

Event-sourced vault-native combat state foundation: 6 encounter event types added to the schema, EncounterState pure reducer added to the projector with combat.md view materialization, headless Vitest suite verifying all LOCKED reducer effects.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend events-schema.ts — 6 encounter event types + relaxed UUID guard | ac7e5fe | events-schema.ts, projector.ts, event-to-engine-mutation.ts, events-schema.test.ts |
| 2 (RED) | Add failing combat-reducer.test.ts | 36e911b | tests/ai/master/vault/combat-reducer.test.ts |
| 2 (GREEN) | Implement EncounterState reducer + combat.md + regeneration hook | 98e7e6d | projector.ts + 7 caller files |

## What Was Built

**events-schema.ts:**
- VAULT_EVENT_TYPES extended 28 → 34 (6 Phase 06 D1 encounter types appended)
- VaultEvent union extended with 6 new discriminated union members (no payload.character)
- ENCOUNTER_EVENT_TYPES exported — Set<string> with the 6 type strings, O(1) membership check
- validateEvent armed for all 6 types; none check payload.character (UUID guard relaxed per CONTEXT §"Event lane")
- event-to-engine-mutation.ts and projector.ts (applyEvent) both received no-op case arms for tsc exhaustiveness

**projector.ts:**
- EncounterState interface + INITIAL_ENCOUNTER_STATE exported
- applyEncounterEvent pure reducer: all 6 LOCKED effects, structuredClone immutability, no I/O, no Date.now/Math.random/process.env
- replayEvents signature updated to return `{ chars: Map<string,CharacterState>; encounter: EncounterState }` — single pass through events.md, ENCOUNTER_EVENT_TYPES.has() routes encounter events; character events route as before
- serializeCombatView: byte-stable hand-rolled YAML (active:false = minimal frontmatter; active:true = full encounter state with turnOrder + monsters YAML sequences)
- regenerateCombatView: parseEventsFile → replayEvents → serializeCombatView → writeFile combat.md
- regenerateAffectedViews extended: encounter events caught first via ENCOUNTER_EVENT_TYPES.has(), regenerateCombatView called, return early (character regen path does NOT run for encounter events)

**tests/ai/master/vault/combat-reducer.test.ts (new — 28 tests):**
- Suite A: 12-event step-by-step reducer assertions (all LOCKED effects verified at each prefix)
- Suite B: defensive/edge cases (unknown id, empty turnOrder, events before combat_start, idempotent duplicate spawn)
- Suite C: combat.md round-trip (serialize → parse frontmatter, byte-stability assertion)
- Suite D: replay determinism (10x same input → identical JSON.stringify)
- Suite E: regression — no-combat_start events.md; char reducer still produces correct state
- Suite F: ENCOUNTER_EVENT_TYPES membership
- Suite G: regenerateCombatView disk write + regenerateAffectedViews routing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Six callers of replayEvents treated return value as a Map directly**
- **Found during:** Task 2 GREEN implementation (tsc check after changing replayEvents signature)
- **Issue:** replayEvents previously returned `Map<string,CharacterState>` directly; 9 files called `.get()`, `.size`, `.has()`, `.keys()` on the result without destructuring
- **Fix:** Updated all callers to destructure `{ chars }` or use `.chars.get()` etc.
- **Files modified:** scripts/vault-rebuild-views.ts, src/ai/master/vault/parity-check.ts, src/ai/master/vault/snapshot-reader.ts, tests/ai/master/vault/projector.test.ts, tests/ai/master/vault/apply-event-integration.test.ts, tests/sessions/vault-mutations-resume.test.ts
- **Commit:** 98e7e6d

**2. [Rule 1 - Bug] events-schema.test.ts hardcoded count 28 became stale**
- **Found during:** Task 1 verification (events-schema.test.ts failure)
- **Issue:** Test asserted VAULT_EVENT_TYPES.length === 28; after adding 6 Phase 06 types the count is 34
- **Fix:** Updated test description and count assertion to 34, added Phase 06 type strings to the expected Set
- **Files modified:** tests/ai/master/vault/events-schema.test.ts
- **Commit:** ac7e5fe

**3. [Rule 2 - Missing critical functionality] event-to-engine-mutation.ts lacked encounter type arms**
- **Found during:** Task 1 tsc verification
- **Issue:** The function's default: never arm produced a tsc error because the new VaultEvent union members had no case arm
- **Fix:** Added 6 encounter type case arms that are explicit no-ops with a comment explaining REQ-037 (no Postgres combat writes in D1)
- **Files modified:** src/sessions/event-to-engine-mutation.ts
- **Commit:** ac7e5fe

## Known Stubs

None. The plan's outputs are complete and functional. The snapshot wiring (plan 06-02) and LLM tool exposure (D2) are explicitly deferred by the phase boundary.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns outside the existing vault campaigns root, or schema changes at trust boundaries. serializeCombatView is pure (no I/O). regenerateCombatView writes only to campaignDir (UUID-guarded, same as existing character view writes). ENCOUNTER_EVENT_TYPES has no LLM exposure in D1.

## TDD Gate Compliance

- RED gate: commit 36e911b — `test(06-01): add failing combat-reducer tests (TDD RED)` — 25/28 tests failed as expected
- GREEN gate: commit 98e7e6d — `feat(06-01): implement EncounterState reducer + combat.md view + regeneration hook (TDD GREEN)` — all 28 tests pass

## Self-Check

Checking created files and commits...
