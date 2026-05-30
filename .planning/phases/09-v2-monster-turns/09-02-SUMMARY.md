---
phase: 09
plan: 02
subsystem: vault-combat-v2
tags: [monster-turns, combat-resolver, pure-function, injectable-rng, cr-table]
# Dependency graph (for forward-planning agents)
requires:
  - "src/engine/dice.ts (rollD20, rollDamage — RNG as last param)"
  - "src/engine/rand.ts (Rng, defaultRng, makeSeededRng)"
  - "src/ai/master/vault/projector.ts (EncounterState type)"
  - "src/ai/master/vault/events-schema.ts (VaultEvent: hp_change{character,delta}, turn_advance)"
  - "src/app/api/sessions/[id]/turn/combat-resolver.ts (v1 hit rule + named-constant pattern, mirrored not modified)"
provides:
  - "resolveMonsterTurn — pure single-monster-attack primitive (events out, never throws, injectable RNG)"
  - "getMonsterAttackStats — bestiary>CR-table>default attack-profile resolver"
  - "MonsterTurnResult — the per-turn contract the 09-04 loop returns to the 09-06 route"
  - "DEFAULT_MONSTER_ATTACK_BONUS / DEFAULT_MONSTER_DAMAGE_DIE — named-constant default profile"
  - "CR_TO_ATTACK_STATS — module-internal CR→stats table (nearest-floor lookup)"
affects:
  - "src/app/api/sessions/[id]/turn/monster-turns.ts (new)"
  - "tests/app/api/sessions/[id]/turn/monster-turns.test.ts (new)"
# Tech stack signals (for pattern matching)
tech-stack: [typescript, nextjs-16, vitest]
patterns: [pure-function, injectable-rng-default-param, named-constant-defaults, nearest-floor-table-lookup, defensive-null-edge, verbatim-rule-reuse]
key-files:
  - "src/app/api/sessions/[id]/turn/monster-turns.ts"
  - "tests/app/api/sessions/[id]/turn/monster-turns.test.ts"
decisions:
  - "Sibling module (not inside combat-resolver.ts) keeps v1 player resolver byte-untouched"
  - "Above-range CR (e.g. 999) → CR 17 row (largest key ≤ cr), not default — documented nearest-floor choice"
  - "DEFAULT_PLAYER_AC named constant (=12) for the pcAcById miss fallback — no inline magic number"
metrics:
  duration: "~5 min"
  completed: "2026-05-30"
  tasks: 2
  files: 2
  tests_added: 29
---

# Phase 09 Plan 02: Monster-Turn Primitives Summary

Created the new sibling module `src/app/api/sessions/[id]/turn/monster-turns.ts` holding the PURE, deterministic monster-turn primitives that the 09-04 loop and 09-06 route compose: a CR→(attackBonus, damageDice) table with nearest-floor lookup, named-constant default profile, the `getMonsterAttackStats` resolver (bestiary > CR-table > default precedence), and `resolveMonsterTurn` — a single monster attack that rolls d20 + damage through ONE injectable RNG, applies the v1 hit rule verbatim (no crit-doubling), picks a random live PC, and emits `hp_change(PC,-dmg)+turn_advance` on hit / `turn_advance` on miss. The v1 player resolver (`combat-resolver.ts`) was mirrored but left byte-untouched.

## Performance

- Test suite (29 tests): ~16 ms execution (pure functions, seeded RNG — no I/O).
- `npx tsc --noEmit`: clean, 0 errors.
- Full repo suite after change: 1170 passed / 1 pre-existing unrelated failure (see below).

## What Changed

- **D-05 CR table:** `CR_TO_ATTACK_STATS` module-level const with RESEARCH Pattern 4's cross-validated rows (keys 0,1,2,3,4,5,6,8,12,17). `CR_KEYS` precomputed ascending for the nearest-floor lookup.
- **D-06 named-constant defaults:** exported `DEFAULT_MONSTER_ATTACK_BONUS = 4` and `DEFAULT_MONSTER_DAMAGE_DIE = '1d6'`, mirroring v1's `DEFAULT_MONSTER_AC = 12`.
- **`getMonsterAttackStats`:** 3-level precedence — (1) `input.bestiary` if non-null, (2) validated `cr` (`Number.isFinite(cr) && cr >= 0`) → nearest-floor table lookup, (3) named-constant default. Malformed cr (NaN/Infinity/negative) falls back to default; never throws (T-09-04).
- **D-09/D-10/D-11 `resolveMonsterTurn`:** picks a random live PC via `rng.intInclusive`, resolves AC from `pcAcById` (named-constant `DEFAULT_PLAYER_AC` fallback), rolls d20 with `rollD20({modifier}, rng)`, applies the **verbatim** v1 hit rule `natural !== 1 && (natural === 20 || total >= ac)`, rolls damage with `rollDamage(dice, {}, rng)` (NO `crit` flag → no doubling), emits `hp_change{character:pcId, delta:-damage}` then `turn_advance` on hit / `turn_advance` only on miss. Empty `livePcIds` → `null` (defensive, never throws).
- **`MonsterTurnResult`** interface exported — the contract the loop returns to the route (monsterName, hit, natural, total, ac, damage, pcTargetId, events).
- **29 seeded unit tests:** CR floor/mid/high + nearest-floor + above-range + malformed-cr-default + bestiary-precedence + every-table-dice-rollDamage-consumable; hit-rule boundaries (nat1/nat20/total==ac/total==ac-1) + no-crit-doubling + RNG determinism (same seed twice) + random-live-PC target (1v1 collapse, multi-PC pool membership, >1 distinct over many seeds) + empty-pool null.

## Key Files

- `src/app/api/sessions/[id]/turn/monster-turns.ts` — the new pure primitives module (CR table, defaults, `getMonsterAttackStats`, `resolveMonsterTurn`, `MonsterTurnResult`). NO `next/*` imports — framework-agnostic colocated helper.
- `tests/app/api/sessions/[id]/turn/monster-turns.test.ts` — 29 seeded headless unit tests covering every behavior case in both tasks.

## Decisions

- **Sibling module, not inside `combat-resolver.ts`** (plan-sanctioned Claude's-discretion file choice): keeps the v1 player resolver byte-untouched and mirrors its "pure function, injectable RNG, events out, never throws" contract.
- **Above-range CR resolves to the CR 17 row, not the default.** `cr = 999` is the largest-key-≤-cr (17), consistent with the nearest-floor rule. A CR above the top breakpoint is a powerful monster, so the strongest tabled profile is the safer approximation than collapsing to the +4/1d6 floor. Documented inline in the JSDoc and asserted in the test.
- **`DEFAULT_PLAYER_AC` named constant (= 12) for the `pcAcById.get` miss fallback** — the route's D-12 bridge normally supplies every live PC's AC, but the defensive fallback uses a named constant (reusing v1's monster-AC value) rather than an inline magic number, per the plan's explicit instruction.
- **v2 event INVERTS v1:** v1 emitted `monster_hp_change{id,delta}` (PC hits monster); v2 emits `hp_change{character,delta}` (monster hits PC). Confirmed payload shape against `events-schema.ts:261` (`{ character: string; delta: number }`) and `turn_advance` at line 321 (`Record<string, never>` → `{}`).

## Deviations from Plan

None — plan executed exactly as written. No bugs, missing functionality, or blocking issues encountered. All acceptance-criteria grep gates and `tsc --noEmit` passed on the first implementation; no REFACTOR pass was needed.

## Known Stubs

None. Both exported functions are fully wired to real inputs (CR table, dice engine, RNG seam). The `bestiary` input to `getMonsterAttackStats` is an injected parameter the D-04 path (09-03) will feed; it is a typed seam, not a stub — the function fully handles both the present and null/absent cases (tested).

## For Future Agents

- **09-04 (loop) consumes this:** call `getMonsterAttackStats({cr, bestiary})` to get the profile, then `resolveMonsterTurn({monster, attackBonus, damageDice, livePcIds, pcAcById, rng})` per monster turn. `livePcIds` MUST be pre-filtered to PCs that are in `turnOrder` AND have `hpCurrent > 0` (the function does NOT filter — it trusts the caller's live-pool). A `null` return means "no live PC" → stop the loop.
- **09-03 (bestiary) feeds the `bestiary` param:** produce a `{attackBonus, damageDice}` object (or null); `getMonsterAttackStats` gives it precedence over cr/default. The `damageDice` it returns MUST match the dice.ts grammar `^(\d+)d(\d+)([+-]\d+)?$` or `rollDamage` will throw.
- **09-06 (route) emits the events:** each `MonsterTurnResult.events` is plain `{type, payload}` VaultEvents (no envelope) ready for the existing vault dispatcher, identical shape discipline to v1's `ResolveCombatResult.events`.
- **Determinism is the testability contract (D-10):** ALL randomness routes through the single injected `Rng`. There is NO `Math.random` in this module (grep-gated). To seed deterministically in tests, pass `rng: makeSeededRng(seed)`. The draw ORDER inside `resolveMonsterTurn` is: target-pick FIRST, then d20, then (on hit) damage — `seedForNatural` in the test mirrors this order to find a seed forcing a specific natural.
- **No crit-doubling (deferred to v3):** `rollDamage` is called with `{}` (empty opts), never `{crit:true}`, so a nat-20 rolls single dice — symmetric with v1.
- **Pre-existing out-of-scope failure:** `tests/applicator/applicator.test.ts` has 1 failing test, unrelated to combat (last touched by `7ad8533`, before Phase 08; already logged in `08/deferred-items.md`). NOT introduced by this plan — my two commits touch only `monster-turns.ts` + its test.

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/monster-turns.ts` — FOUND
- `tests/app/api/sessions/[id]/turn/monster-turns.test.ts` — FOUND
- Commit `97e87e7` (test/RED) — FOUND in git log
- Commit `4d9c8e0` (feat/GREEN) — FOUND in git log
- `npx vitest run tests/app/api/sessions/[id]/turn/monster-turns.test.ts` — 29/29 PASS, exit 0
- `npx tsc --noEmit` — clean, exit 0
- All acceptance-criteria grep gates — PASS (CR table + named constants present; Number.isFinite present; v1 hit rule verbatim; hp_change{character} one match; NO Math.random; resolveMonsterTurn exported)
