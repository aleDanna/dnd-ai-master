---
phase: 07-vault-combat-playable-d2
plan: "03"
subsystem: sessions/turn-route
tags: [combat, vault, multiplayer, tdd, turn-interleaving]
dependency_graph:
  requires: [07-01, 07-02, 06-01, 06-02]
  provides: [turnOrder-driven-handoff, combat-interleaving, non-combat-regression-guard]
  affects: [src/app/api/sessions, tests/sessions]
tech_stack:
  added: []
  patterns: [pure-helper-extraction, try-catch-fallback, tdd-red-green]
key_files:
  created:
    - src/app/api/sessions/[id]/turn/combat-handoff.ts
    - tests/sessions/vault-combat-turn-interleaving.test.ts
  modified:
    - src/app/api/sessions/[id]/turn/route.ts
decisions:
  - "Extract combat handoff logic into resolveCombatHandoff() pure helper (testable without DB/Clerk)"
  - "resolveCombatHandoff returns 3-way union: 'advance' | 'skip' | 'fallback' (distinct from TurnAdvanceDecision to signal whether fallback path runs)"
  - "Re-read encounter from events.md via parseEventsFile+replayEvents inside the transaction (explicit, safe; does not depend on snap exposing EncounterState)"
  - "Entire combat block wrapped in try/catch — any exception falls through to existing detectAddressee path; non-combat sessions cannot be broken by a bug in the new code"
  - "combatHandoffDone flag gates the fallback: set true for 'advance' and 'skip', not set for 'fallback'"
metrics:
  duration: "7 minutes"
  completed: "2026-05-28"
  tasks_completed: 1
  files_changed: 3
---

# Phase 07 Plan 03: Combat Turn Interleaving Summary

**One-liner:** turnOrder-driven PC/monster handoff in vault branch via `resolveCombatHandoff()` pure helper; detectAddressee/computeTurnAdvance fallback unchanged for non-combat turns.

## What Was Built

### `src/app/api/sessions/[id]/turn/combat-handoff.ts` (new)

Pure helper `resolveCombatHandoff({ encounter, party })` returns:
- `{ kind: 'advance', nextCharacterId }` — actor is PC UUID in party → hand off
- `{ kind: 'skip' }` — actor is monster (not in party) → no handoff
- `{ kind: 'fallback' }` — encounter inactive / turnOrder empty / idx out of range → caller uses existing path

Trust gate (T-07-03-01): actorId is ONLY used in `party.some(p => p.id === actorId)`. Monster ids never match DB-sourced PC UUIDs.

### `src/app/api/sessions/[id]/turn/route.ts` (modified vault branch)

Vault branch transaction block (`7v-combat`) — inserted before the existing `detectAddressee` call:

1. `parseEventsFile(eventsPath(campaignId))` + `replayEvents()` re-reads the encounter state (read-only; loop has already committed its `apply_event` writes).
2. Calls `resolveCombatHandoff({ encounter, party })`.
3. On `'advance'`: updates `currentPlayerCharacterId` + emits `turn-change` (same DB/notify pattern as existing path).
4. On `'skip'`: sets `combatHandoffDone = true`; no DB update, no notification.
5. On `'fallback'` (or any exception): runs the existing `detectAddressee` + `computeTurnAdvance` path unchanged.
6. Entire block in `try/catch` — exception falls back to existing path with a `console.warn`.

### `tests/sessions/vault-combat-turn-interleaving.test.ts` (new, 8 tests)

TDD RED then GREEN. Suite A (active encounter): PC actor → advance, monster → skip, wrap-around PC → advance. Suite B (fallback): inactive, empty turnOrder, out-of-range idx. Suite C (regression): `INITIAL_ENCOUNTER_STATE` → fallback + monster-only encounter → skip.

## Verification Results

- `pnpm vitest run tests/sessions/vault-combat-turn-interleaving.test.ts` — 8/8 pass
- `pnpm vitest run tests/sessions/` — 219 pass, 26 skip, 1 pre-existing failure (`applicator/gp-stack`)
- `pnpm vitest run tests/multiplayer/` — 35/35 pass
- `pnpm tsc --noEmit` — exit 0
- `grep -c 'turnOrder' route.ts` — 2 (new interleaving code present)
- `grep -c 'detectAddressee' route.ts` — 7 (existing calls preserved in fallback)

## Deviations from Plan

None — plan executed exactly as written.

The plan suggested either `materializeFromVault` or `parseEventsFile+replayEvents` as the encounter read approach. Chose `parseEventsFile+replayEvents` directly (the explicit/safe approach) because `materializeFromVault` requires a `characterId` parameter not available in the transaction context, whereas `parseEventsFile+replayEvents` takes only `campaignId` (which is already read from the session row).

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced. The `party.some()` trust gate (T-07-03-01 mitigation) is present. Try/catch fallback for T-07-03-02 is present.

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/combat-handoff.ts` — FOUND
- `tests/sessions/vault-combat-turn-interleaving.test.ts` — FOUND
- Commit `372baf7` (RED tests) — FOUND
- Commit `5266e1a` (GREEN implementation) — FOUND
