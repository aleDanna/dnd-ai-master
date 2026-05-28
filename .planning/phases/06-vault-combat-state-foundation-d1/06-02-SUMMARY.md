---
phase: 06-vault-combat-state-foundation-d1
plan: "02"
subsystem: vault-snapshot
tags: [combat, event-sourcing, snapshot, actors, headless-tests]
dependency_graph:
  requires:
    - "06-01: EncounterState + replayEvents { chars, encounter } + combat.md"
  provides:
    - "snapshot-reader.ts: VaultMaterializeResult { state, encounter } return type"
    - "snapshot-reader.ts: inCombat + combat derived from EncounterState (not hard-coded)"
    - "client-snapshot.ts: buildVaultActors(encounter, sessionId) exported helper"
    - "client-snapshot.ts: actors conditionally from vault encounter monsters (no Postgres combat_actors query for vault sessions)"
    - "tests/ai/master/vault/combat-snapshot.test.ts: 26 headless snapshot-shape tests"
  affects:
    - "tests/ai/master/vault/snapshot-reader.test.ts (updated to access r!.state.field)"
tech_stack:
  added: []
  patterns:
    - "VaultMaterializeResult { state, encounter } wraps Partial<SessionState> + EncounterState so callers get both from one replay pass"
    - "buildVaultActors is a pure exported function — testable without DB, follows the same pure-function discipline as applyEncounterEvent"
    - "vault actors conditional: vaultEncounter !== null short-circuits the Postgres combat_actors query"
key_files:
  created:
    - "tests/ai/master/vault/combat-snapshot.test.ts"
  modified:
    - "src/ai/master/vault/snapshot-reader.ts"
    - "src/sessions/client-snapshot.ts"
    - "tests/ai/master/vault/snapshot-reader.test.ts"
decisions:
  - "materializeFromVault return type changed from Partial<SessionState>|null to VaultMaterializeResult|null — additive change; exposes encounter without a second replay; callers (client-snapshot.ts) destructure { state, encounter }"
  - "buildVaultActors exported from client-snapshot.ts (not snapshot-reader.ts) — it maps EncounterState to CombatActorRow[], which is a session-layer concern; keeping it co-located with the buildClientSnapshot that calls it"
  - "Postgres combat_actors query is skipped entirely on vault path (not just ignored) — vault campaigns never write to combat_actors; skipping avoids a needless DB round-trip; if actor data is somehow needed from Postgres the null fallback (vaultEncounter===null) still runs the query"
  - "snapshot-reader.test.ts updated from r!.field to r!.state.field — the test was accessing Partial<SessionState> fields directly; the return type change to VaultMaterializeResult made those accesses wrong (Rule 1 auto-fix)"
metrics:
  duration_seconds: 120
  tasks_completed: 2
  files_modified: 3
  files_created: 1
  completed_date: "2026-05-28"
---

# Phase 6 Plan 2: Vault Combat State Foundation D1 Snapshot Wiring Summary

Headless snapshot pipeline wired: `inCombat`/`combat` on SessionState now derived from `EncounterState`; vault actors sourced from encounter monsters (not Postgres `combat_actors`); verified by 26 new headless tests and all 657 existing vault tests still passing.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | snapshot-reader.ts — derive inCombat + combat from EncounterState | 58af5ca | snapshot-reader.ts, snapshot-reader.test.ts |
| 2 | client-snapshot.ts — vault actors from encounter monsters + snapshot-shape tests | 2b4b7ac | client-snapshot.ts, combat-snapshot.test.ts |

## What Was Built

**src/ai/master/vault/snapshot-reader.ts:**
- `VaultMaterializeResult` interface exported: `{ state: Partial<SessionState>; encounter: EncounterState }` — one replay pass produces both outputs for callers
- `materializeFromVault` return type changed from `Partial<SessionState> | null` to `VaultMaterializeResult | null`; destructures `{ chars, encounter }` from `replayEvents`; passes `encounter` to `translateCharacterState`
- `translateCharacterState` gains `encounter: EncounterState` parameter; replaces two hard-coded lines:
  - `inCombat: false` → `inCombat: encounter.active`
  - `combat: null` → `encounter.active ? { round, currentIdx, turnOrder } : null`
- The `combat` object shape exactly matches the `session_state.combat` column type (`{ round, currentIdx, turnOrder: { actorId, initiative }[] }`)

**src/sessions/client-snapshot.ts:**
- `buildVaultActors(encounter, sessionId): CombatActorRow[]` exported helper:
  - Returns `[]` when `encounter.active === false` (no active combat)
  - Maps `encounter.monsters` → `CombatActorRow[]`
  - `initiative` sourced from matching `turnOrder` entry; defaults to `0` when monster not yet in turn order
  - `monsterSlug: null` (bestiary is D2)
  - `conditions: string[]` → `{ slug, source:'vault-encounter', durationRounds:'until_removed', appliedRound:0 }[]`
  - Optional fields (`turnState`, `position`, `senses`) omitted in D1 (action economy is D3)
- `buildClientSnapshot` actors branch: `if (vaultEncounter !== null)` uses `buildVaultActors` and skips the Postgres `combat_actors` query; else falls through to the existing Postgres query
- Vault fallback path (null result or throw) still runs the Postgres query unchanged

**tests/ai/master/vault/combat-snapshot.test.ts (new — 26 tests):**
- Suite A (9): mid-encounter field-by-field mapping — id, sessionId, name, monsterSlug, hpCurrent, hpMax, initiative, isAlive, conditions.length
- Suite B (7): condition string→object mapping; source='vault-encounter'; durationRounds='until_removed'; CombatActorRow structural type check
- Suite C (2): initiative defaults to 0 when monster not in turnOrder; no throw on empty turnOrder
- Suite D (2): encounter.active=false → empty array; even when encounter has monsters
- Suite E (6): end-to-end via `materializeFromVault` with real tmpdir+events.md — inCombat:true mid-encounter; combat.round/currentIdx/turnOrder shape; inCombat:false after combat_end; inCombat:false on no-combat campaign; encounter exposed on result object

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] snapshot-reader.test.ts accessed fields directly on materializeFromVault result**
- **Found during:** Task 1 — after changing the return type from `Partial<SessionState>|null` to `VaultMaterializeResult|null`, all field accesses of the form `r!.hpCurrent` broke because the result now has `{ state, encounter }` shape
- **Fix:** Updated all 32 field accesses in snapshot-reader.test.ts from `r!.field` to `r!.state.field`; `expect(r).not.toBeNull()` and `expect(r).toEqual(r2)` assertions left unchanged (they test the result object itself, not a field)
- **Files modified:** `tests/ai/master/vault/snapshot-reader.test.ts`
- **Commit:** 58af5ca

**2. [Rule 1 - Bug] Postgres combatActors type incompatible with CombatActorRow**
- **Found during:** Task 2 tsc check — the Drizzle `CombatActor` DB type has `turnState: TurnState | null` while `CombatActorRow` has `turnState?: {...} | undefined`; also includes extra columns (`custom`, `size`) not in `CombatActorRow`
- **Fix:** Added `as unknown as CombatActorRow[]` cast at the Postgres actors assignment; documented the structural compatibility rationale inline
- **Files modified:** `src/sessions/client-snapshot.ts`
- **Commit:** 2b4b7ac

## Known Stubs

None. The plan's outputs are complete and functional:
- `inCombat` and `combat` are now encounter-derived on the vault path
- `actors` is sourced from vault encounter monsters when `sourceOfTruth==='vault'`
- All CombatActorRow fields are properly mapped

The snapshot is now ready for the CombatTracker to render vault combat state once D2 flips a live campaign's `sourceOfTruth` to `'vault'` (the D2 operator step).

## Threat Flags

None — no new network endpoints, auth paths, or schema changes at trust boundaries. `buildVaultActors` is pure (no I/O). The vault actors path is gated by the existing `sourceOfTruth === 'vault'` check in `buildClientSnapshot` which is protected by the existing auth gate.

## Self-Check

Checking created files and commits...
