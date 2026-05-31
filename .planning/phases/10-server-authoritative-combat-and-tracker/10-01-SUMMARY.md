---
phase: 10-server-authoritative-combat-and-tracker
plan: "01"
subsystem: combat-opener
tags: [tdd, pure-function, encounter-opener, server-authoritative, combat]
dependency_graph:
  requires: []
  provides:
    - runEncounterOpener (pure function, src/app/api/sessions/[id]/turn/encounter-opener.ts)
  affects:
    - src/app/api/sessions/[id]/turn/route.ts (10-03 will wire this function)
tech_stack:
  added:
    - encounter-opener.ts (pure TypeScript module, node:crypto randomUUID only)
  patterns:
    - CR-to-HP fallback table (nearest-floor lookup, mirrors monster-turns CR-to-attack table)
    - Dependency-injected bestiaryLookup (D-02 swappable monster-selection seam)
    - Empty-party guard returns [] immediately (D-01 locked contract)
key_files:
  created:
    - src/app/api/sessions/[id]/turn/encounter-opener.ts
    - tests/app/api/sessions/[id]/turn/encounter-opener.test.ts
  modified: []
decisions:
  - "runEncounterOpener is pure: node:crypto randomUUID only import; zero v1/v2 file dependencies"
  - "BestiaryStats interface accepts hpMax?, ac?, cr? — all optional; opener degrades gracefully on any missing field (T-10-02)"
  - "HP fallback table uses CR breakpoints matching DMG typical HP ranges (0→7, 1→11, 2→22 … 17→218)"
  - "Initiative is 1d20+0 for PCs (INFO-9: no initiativeBonus in characters schema) and monster"
  - "Initiative_set entries are sorted descending (highest first, D&D 5e rule); PC-before-monster on ties (UX intent)"
  - "CR string fractions ('1/4', '1/2') parsed to numeric via parseCr(); forwarded as numeric cr in monster_spawn payload"
  - "ac forwarded when lookup provides it (v1 combat-resolver reads monster.ac ?? 12)"
metrics:
  duration_seconds: 447
  completed_date: "2026-05-31"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
---

# Phase 10 Plan 01: Encounter Opener Pure Function — Summary

**One-liner:** Pure `runEncounterOpener(snapshot, monsterName, bestiaryLookup)` with CR-table HP fallback, empty-party guard, and four-behavior TDD test suite (RED→GREEN).

## What Was Built

`runEncounterOpener` is the deterministic, server-authoritative encounter opener
for REQ-045. It takes the session snapshot (reads only `snapshot.party`), a
monster name string (opaque — no path building, T-10-01), and a synchronous
`bestiaryLookup` callback injected by the caller.

**Behavior contract (all four cases pass):**

1. **Happy path** — resolves `hpMax` from the injected lookup, generates a
   `randomUUID()` monster id, rolls 1d20+0 initiative for each PC and the monster,
   sorts descending, and returns `[monster_spawn, initiative_set]`.

2. **Empty party** — returns `[]` immediately. Combat is never opened when there
   are no PCs (the post-combat handoff needs at least one PC UUID in `turnOrder`
   to return player control via `resolveCombatHandoff`).

3. **REQ-047 invariant** — the opener emits ZERO damage / `monster_hp_change`
   events. The opening turn is encounter setup only.

4. **Null bestiary fallback** — when `bestiaryLookup` returns `null`, `hpMax`
   derives from a CR-to-HP table (nearest-floor, mirroring the CR-to-attack-stats
   table in `monster-turns.ts`). Default is 7 HP when CR is unknown. NEVER throws.

**Swappability (D-02):** The opener does not choose the monster (name is passed
in) and gets stats only through the injected `bestiaryLookup`. The future
option-A constrained-JSON LLM path can replace the caller's lookup without
touching this file.

## Test Results

- 14 tests defined across 4 `describe` blocks
- RED: suite failed (Cannot find module) — confirmed before Task 2
- GREEN: all 14 pass after implementation
- `tsc --noEmit`: clean (no type errors)
- Pre-existing failures: applicator/gp-stack, scene-image-coalesce, tts-coalesce, preferences-local-validation — documented in CONTEXT.md, not charged to this plan

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (RED) | 2fdcf84 | test(10): add failing encounter-opener contract tests |
| 2 (GREEN) | 37382fd | feat(10): implement server-authoritative encounter opener |

## Deviations from Plan

None — plan executed exactly as written.

- Task 1 RED: test file written with four describe blocks exactly matching the plan's four behaviors; confirmed FAIL before commit.
- Task 2 GREEN: pure function implemented; tsc clean; 14/14 pass; no v1/v2 imports.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes were introduced. The `encounter-opener.ts` module is a pure in-process function with no I/O. The threat model from the plan's `<threat_model>` is fully addressed:

- T-10-01 (Tampering / monsterName): monsterName used only as string key + label; zero path building.
- T-10-02 (DoS / null bestiary): null lookup degrades to bounded CR-default HP; function never throws.
- T-10-03 (Info disclosure / monster_spawn payload): accepted — {id,name,hpMax} is public encounter data.

## Known Stubs

None. The function is complete and wired to be called by the route (10-03). No data flows to the UI from this module directly — the route dispatches the returned events via `dispatchVaultTool`.

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/encounter-opener.ts` — FOUND
- `tests/app/api/sessions/[id]/turn/encounter-opener.test.ts` — FOUND
- commit 2fdcf84 — FOUND
- commit 37382fd — FOUND
