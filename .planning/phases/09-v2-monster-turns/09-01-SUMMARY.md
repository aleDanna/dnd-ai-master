---
phase: 09
plan: 01
subsystem: vault-combat-events
tags: [d-08, monster-spawn, cr, projector, validator, additive, back-compat]
# Dependency graph metadata
requires: []
provides:
  - "monster_spawn event carries an optional, validated cr?: number (fractions allowed)"
  - "EncounterState.monsters[].cr populated by the projector reducer from the server-controlled monster_spawn event"
affects:
  - "09-02 (CR table reads EncounterState.monsters[].cr)"
  - "09-04 (combat loop / resolver reads cr at attack time)"
  - "D-05 cr->table->resolver chain (this is the smoke-critical leaf)"
tech-stack:
  added: []
  patterns:
    - "additive optional field on a VaultEvent union variant (mirrors ac?/initiativeBonus?)"
    - "validateEvent optional-field branch with relaxed integer constraint (non-negative finite, fractions OK)"
    - "reducer conditional copy guarded by `cr !== undefined` (mirrors ac/initiativeBonus copies)"
    - "byte-stable replay test via JSON.stringify equality on a cr-less event sequence"
key-files:
  created: []
  modified:
    - src/ai/master/vault/events-schema.ts
    - src/ai/master/vault/projector.ts
    - tests/ai/master/vault/events-schema.test.ts
    - tests/ai/master/vault/projector.test.ts
decisions:
  - "cr validator uses a RELAXED integer constraint vs ac (Number.isFinite + >= 0, NOT Number.isInteger) so CR 1/4 (0.25) and CR 1/2 (0.5) are valid; CR 0 is accepted (RESEARCH 354-358)"
  - "cr is strictly additive on BOTH the event type and the EncounterState member; cr-absent payloads/logs are byte-identical to pre-change output (D-08 back-compat, no migration)"
  - "cr error message: 'monster_spawn.cr must be a non-negative finite number when provided' (mirrors the ac error phrasing)"
metrics:
  duration: ~14m
  completed: 2026-05-30
---

# Phase 09 Plan 01: monster_spawn cr (schema + projector propagation) Summary

Added an additive, validated `cr?: number` to the `monster_spawn` event and propagated it through the projector reducer into `EncounterState.monsters[].cr`, closing both halves of RESEARCH state-gap 2 (D-08) with byte-stable back-compat.

## What Was Built

The `monster_spawn` event type now accepts an optional numeric difficulty hint `cr` (Claude's-discretion field choice: lean numeric CR, not a `tier` enum). `validateEvent` validates it as a non-negative finite number — fractions like 0.25 (CR 1/4) and 0.5 (CR 1/2) are accepted, CR 0 is valid, and non-numbers / NaN / Infinity / negatives are rejected with an explicit error before the value can reach state. The projector's `monster_spawn` reducer copies `cr` verbatim from the (server-controlled) event into the new optional `EncounterState.monsters[].cr` member, so the downstream CR table (09-02) and combat loop / resolver (09-04) can read difficulty at attack time. The change is strictly additive on both the event type and the state member: a `cr`-less event log validates and replays JSON-byte-identical to the pre-change output, so no DB migration is needed (REQ-004/007 — `cr` is in-app, not a Postgres column).

## Key Decisions

- **Relaxed integer constraint for `cr` (vs `ac`).** `ac` uses `Number.isInteger`; `cr` deliberately does not, because fractional CRs (1/4, 1/2) are legitimate D&D values. The `cr` branch rejects only `typeof !== 'number' || !Number.isFinite || < 0`. CR 0 is explicitly valid. (RESEARCH 354-358; PATTERNS 204-268.)
- **Additive on both type and state, no migration.** `cr?` is appended after `initiativeBonus?` in both the `VaultEvent` variant and the `EncounterState.monsters[]` member, and copied only when present — guaranteeing cr-less logs are byte-stable. A dedicated `JSON.stringify` replay test asserts this (D-08 back-compat).
- **Server-authoritative only.** `cr` is copied verbatim from the `monster_spawn` event; the reducer introduces no new player-input surface (threat T-09-03).

## Deviations from Plan

None - plan executed exactly as written. No bugs, missing functionality, or blocking issues encountered; the existing `ac`/`initiativeBonus` patterns transferred cleanly (Rules 1-3 not triggered; no Rule 4 architectural decisions). No authentication gates. No package installs.

## Integration Points

- **Event log -> validator:** `validateEvent` is the input-validation gate (ASVS V5) for `cr`; a malformed `cr` is rejected before it can reach state or the downstream CR-table lookup (threat T-09-01 mitigated).
- **Validated event -> EncounterState:** `applyEncounterEvent` (`monster_spawn` case) is the only writer of `EncounterState.monsters[].cr`; it sources `cr` exclusively from the server-controlled event (threat T-09-03).
- **EncounterState.cr -> downstream (09-02 / 09-04):** the CR table and resolver/loop will read `monsters[].cr` at attack time. This plan is the smoke-critical leaf of the D-05 `cr -> table -> resolver -> loop -> route -> narration` chain.

## Files

- `src/ai/master/vault/events-schema.ts` — added `cr?: number` to the `monster_spawn` payload in the `VaultEvent` union (after `initiativeBonus?`); added `cr?: number` to the `spawnPayload` decl and a relaxed-constraint validation block (non-negative finite; fractions OK) in the `validateEvent` `monster_spawn` branch.
- `src/ai/master/vault/projector.ts` — added `cr?: number` to the `EncounterState.monsters[]` member; added `cr` to the `monster_spawn` reducer destructure and an `if (cr !== undefined) monster.cr = cr;` conditional copy before `base.monsters.push(monster)`.
- `tests/ai/master/vault/events-schema.test.ts` — added 8 `cr` validation tests (int accepted, fraction 0.25 accepted, CR 0 accepted, negative/NaN/Infinity/string rejected, cr-absent yields no cr key).
- `tests/ai/master/vault/projector.test.ts` — added 4 reducer tests (cr propagated alone, cr alongside ac/initiativeBonus, cr-absent yields no cr key, cr-less sequence replays JSON-byte-identical to the pre-change snapshot).

## Verification

- `pnpm exec vitest run tests/ai/master/vault/events-schema.test.ts tests/ai/master/vault/projector.test.ts` — **31 passed** (20 schema + 11 projector; baseline was 19, +12 new cr tests). Exit 0.
- `pnpm exec tsc --noEmit` — exit 0 (clean) after each task.
- TDD gates verified in git log per task: `test(...)` RED commit precedes the `feat(...)` GREEN commit for both Task 1 (1a3f9c2 -> 7e21b04) and Task 2 (e4d5b8a -> 3c9e0f1). RED runs confirmed the cr-propagation/validation tests failed before implementation (`expected undefined to be 3/5`; `expected true to be false` for negative cr), and the cr-less byte-stable replay test passed in RED and stayed passing through GREEN (proving genuine additivity).
- Acceptance greps all matched: `cr?: number` on the VaultEvent variant (events-schema.ts:317) + spawnPayload decl (1031) + EncounterState member (projector.ts:672); error message (events-schema.ts:1046); `spawnPayload.cr = p.cr` (1057); `const { id, name, hpMax, ac, initiativeBonus, cr }` (projector.ts:747); `if (cr !== undefined) monster.cr = cr` (projector.ts:760).

## TDD Gate Compliance

Plan frontmatter `type: execute` with per-task `tdd="true"`. Both tasks followed RED -> GREEN (no REFACTOR needed — the additive changes mirror the existing `ac`/`initiativeBonus` patterns and required no cleanup). Gate commits present and correctly ordered (see Verification).

## Threat Coverage

All three threat-register dispositions for this plan are `mitigate` and are satisfied:
- **T-09-01 (Input Validation / DoS):** `validateEvent` rejects non-number / NaN / Infinity / negative `cr` before it reaches state — covered by explicit reject tests.
- **T-09-02 (Tampering / replay divergence):** strictly additive change; byte-stable `JSON.stringify` replay test proves cr-less logs project identically (no migration).
- **T-09-03 (Tampering / player-influenced stats):** `cr` copied verbatim from the server-controlled `monster_spawn` event only; reducer adds no player-input surface.

No new security surface introduced beyond the plan's threat_model. No stubs.

## Self-Check: PASSED

- Files verified present: `09-01-SUMMARY.md`, `events-schema.ts`, `projector.ts`, `events-schema.test.ts`, `projector.test.ts`.
- Commits verified in git: `1a3f9c2` (RED schema), `7e21b04` (GREEN schema), `e4d5b8a` (RED projector), `3c9e0f1` (GREEN projector).
