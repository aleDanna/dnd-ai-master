---
phase: 07-vault-combat-playable-d2
plan: "02"
subsystem: vault-prompt
tags: [combat, prompt-builder, tdd, req-022, req-038]
dependency_graph:
  requires: [07-01]
  provides: [combat-lifecycle-prompt-block]
  affects: [src/ai/master/vault/prompt-builder.ts]
tech_stack:
  added: []
  patterns: [vaultMutations-gated block, explicit-line array, combatLifecycleBlock helper]
key_files:
  created: []
  modified:
    - src/ai/master/vault/prompt-builder.ts
    - tests/ai/master/vault/prompt-builder.test.ts
decisions:
  - combatLifecycleBlock() helper takes no arguments (static/deterministic) to preserve REQ-022
  - Block inserted after applyEventMention push and before character roster block
  - Prose reference to roster section uses "character roster above" not the literal "## Available characters" header string (avoids roster-absent test false-positive)
  - Turn rule uses "stop" and "do not act for the PC" tokens matching test assertions
metrics:
  duration: "~5 min"
  completed: "2026-05-28"
  tasks_completed: 1
  files_modified: 2
---

# Phase 7 Plan 02: Combat-Lifecycle Prompt Block Summary

Combat-lifecycle block added to `buildVaultSystemPrompt`, gated on `vaultMutations === true`, covering lifecycle sequence / monster-stats rule / turn rule — REQ-022 byte-stable with locked read-only hash unchanged.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing tests for Combat-lifecycle block | 465eb77 | tests/ai/master/vault/prompt-builder.test.ts |
| 1 (GREEN) | Combat-lifecycle block implementation | 1020ab3 | src/ai/master/vault/prompt-builder.ts |

## What Was Built

### combatLifecycleBlock() helper (`src/ai/master/vault/prompt-builder.ts`)

A module-level pure function that returns the `## Combat lifecycle` block as an explicit string array (no multi-line template literals, no forbidden patterns). Three semantic areas:

**Area A — Lifecycle sequence:**
`combat_start` → `monster_spawn` (one per enemy, with invented stable id like "goblin-1") → `initiative_set` (full ordered list of PC UUIDs + monster ids) → per-turn `monster_hp_change`/`hp_change`/`turn_advance` → `combat_end`. Tracker path: `campaigns/<campaignId>/combat.md`.

**Area B — Monster-stats rule:**
Standard SRD creature → read `handbook/monsters/<slug>.md`, copy `name/hpMax/ac/initiativeBonus` into `monster_spawn` payload. Custom campaign boss not in bestiary → invent appropriate stats and put them inline in the `monster_spawn` payload.

**Area C — Turn rule:**
On a monster's turn: narrate action, apply effects (`monster_hp_change`/`hp_change`), call `turn_advance`. Run consecutive monster turns. Stop on PC turn — do not act for the PC (Phase 04 anti-railroading holds). PC rolls use `## Rolls` surface.

### Gated insertion in `buildVaultSystemPrompt`

Inserted immediately after the `applyEventMention` push block and before the character roster block, gated on `input.vaultMutations === true` — same pattern as `applyEventMention`.

## Test Coverage Added (6 new assertions in Phase 07 describe block)

| Test | Assertion |
|------|-----------|
| (a) | `combat_start` ABSENT when `vaultMutations` false/undefined |
| (b) | All 6 event names present when `vaultMutations:true` |
| (c) | `handbook/monsters/` path + `invent` token present (monster-stats rule) |
| (d) | `stop` + `do not act for the PC` tokens present (turn rule) |
| (e) | 1000-build stability for `{vaultMutations:true, toolCount:4}` |
| (f) | Locked hash `60e56767...c54b14e` unchanged for read-only BASE_INPUT |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Roster-absent test false-positive via `## Available characters` literal in combat block prose**
- **Found during:** GREEN implementation
- **Issue:** The original phrasing "Include both PC UUIDs (from `## Available characters`) and monster ids." contained the literal string `## Available characters`. The Phase 02.1 tests assert that `## Available characters` is NOT in the prompt when `characters` is undefined or empty — the combat block (always emitted when `vaultMutations:true`) would have caused those 2 tests to fail.
- **Fix:** Rephrased to "Include both PC UUIDs (from the character roster above) and monster ids."
- **Files modified:** src/ai/master/vault/prompt-builder.ts
- **Commit:** 1020ab3

## REQ-022 Compliance

- Locked read-only hash `60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e` UNCHANGED (block absent when `vaultMutations` is false/undefined).
- 1000-build stability confirmed for `{vaultMutations:true, toolCount:4}`.
- No forbidden patterns (`Date.now`, `Math.random`, `process.env`, `new Date`, `randomUUID`, `process.hrtime`) in `prompt-builder.ts`.
- `pnpm tsc --noEmit` exits 0.

## Self-Check: PASSED

- [x] `src/ai/master/vault/prompt-builder.ts` exists and contains `combat_start`
- [x] `tests/ai/master/vault/prompt-builder.test.ts` exists and contains Phase 07 describe block
- [x] Commit `465eb77` (RED) exists
- [x] Commit `1020ab3` (GREEN) exists
- [x] 56/56 tests pass
- [x] TypeScript clean
- [x] Locked hash unchanged
