---
phase: 08-server-side-combat-resolver-v1-player-attacks
plan: 01
subsystem: api
tags: [combat, vault, resolver, pure-function, roll-parser, vitest, tdd, REQ-039]

# Dependency graph
requires:
  - phase: 06-vault-combat-state-foundation-d1
    provides: EncounterState shape + monster_hp_change/turn_advance events + reducer HP clamp
  - phase: 07-vault-combat-playable-d2
    provides: combat-handoff.ts pure-helper pattern, isRollResult, roll-result/damage-request string formats
provides:
  - "Pure resolveCombat(rollResult, encounter) → to-hit/damage events + narration directive + damage request, or null"
  - "Roll-result string parser (total/natural/bonus/dice; LAST-parenthetical breakdown + +0 fallback)"
  - "Case-insensitive EXACT name→server-side-id target match (T-08-01 mitigation)"
  - "Hit rule mirrored from engine on the rolled total (nat-1 miss, nat-20 hit, total>=AC)"
  - "Headless REQ-039 resolver-math unit suite (16 cases)"
affects: [08-02 route wiring + narration-only loop, 08-03 turn-directive D-07 suppression]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure turn-route helper (combat-resolver.ts sibling of combat-handoff.ts): no I/O, no clock, no randomness, headless-testable"
    - "Resolver returns plain VaultEvent[] ({type,payload}, NO envelope) — the dispatcher stamps id/version/timestamp"
    - "Never-throw contract: any unparseable/ambiguous/non-combat input → null (graceful fall-through)"

key-files:
  created:
    - "src/app/api/sessions/[id]/turn/combat-resolver.ts"
    - "tests/app/api/sessions/[id]/turn/combat-resolver.test.ts"
  modified: []

key-decisions:
  - "Damage request uses the 'per danni a <target>' lead-in (NOT the spec's 'danni a') — the client extractPurpose requires per/for to capture the target into the roll label (RESEARCH Pitfall 1, verified)"
  - "Hit rule MIRRORED on the rolled total (hit = natural !== 1 && (natural === 20 || total >= ac)) — resolver does NOT call makeAttack (it re-rolls the d20 and needs a full Character, D-09)"
  - "Target match is case-insensitive EXACT against monsters[].name; 0 or >1 matches → null (ambiguous/unknown), then resolve the server-side id (T-08-01 — player can name but cannot inject an id)"
  - "+0 single-die rolls emit no breakdown → parser falls back natural=total (makes nat-20-on-+0 auto-hit work; RESEARCH Pitfall 2)"
  - "HIT emits NO events (turn advances only after the follow-up damage roll); MISS emits turn_advance; DAMAGE emits monster_hp_change(-total) then turn_advance (D-03/D-04)"
  - "kind:'none' arm kept in ResolveCombatResult for the D-02 type contract, but every fall-through returns null (not a 'none' result) today"

patterns-established:
  - "Pure combat resolver in the turn directory mirroring combat-handoff.ts (JSDoc threat-model + determinism contract + early-return gates + EncounterState import-type)"
  - "Roll-result parse helper anchored to the LAST parenthetical with a +0/no-breakdown natural=total fallback"

requirements-completed: [REQ-039]

# Metrics
duration: ~20min
completed: 2026-05-29
---

# Phase 08 Plan 01: Pure resolveCombat Function + Headless Suite Summary

**Deterministic, pure `resolveCombat` that turns a player's roll-result string + the active EncounterState into to-hit/damage VaultEvents, a narration directive, and a `per danni a`-form damage request (or `null`) — backed by a 16-case headless REQ-039 suite.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-29 (session start)
- **Completed:** 2026-05-29
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- Pure `resolveCombat` (no I/O, clock, env, randomness) implementing the D-02 contract: to-hit (hit/miss vs AC), damage (HP delta + turn advance), and `null` on every fall-through edge.
- Roll-result string parser handling the LAST-parenthetical breakdown plus the `+0`/single-die no-breakdown case (`natural = total`), so nat-20-on-+0 auto-hits.
- Hit rule mirrored from `attack.ts` on the rolled total (nat-1 auto-miss, nat-20 auto-hit, else `total >= AC`); default AC 12, default die `1d6` (D-08).
- Threat mitigations baked in: case-insensitive EXACT name→server-side-id match (T-08-01); never-throw → `null` (T-08-03); only the HP `delta` emitted, clamp stays in the reducer (T-08-02).
- 16-case headless unit suite covering every REQ-039 Wave 0 row, including the `parseRollRequests` round-trip proving the `per danni a` form carries the target (RESEARCH Pitfall 1 closed).

## Task Commits

Each task was committed atomically:

1. **Task 1: Pure resolveCombat function + parsing helpers** - `e80293f` (feat)
2. **Task 2: Headless REQ-039 resolveCombat unit suite** - `1722ac4` (test)

_Note: this plan's two tasks map to the implementation file (Task 1) and its headless suite (Task 2); both were verified green before commit._

## Files Created/Modified
- `src/app/api/sessions/[id]/turn/combat-resolver.ts` - Pure `resolveCombat` + `ResolveCombatResult` + `parseRoll`/`matchMonster` helpers (REQ-039, D-02..D-05, D-08).
- `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` - 16 headless cases (also created the new `tests/app/api/sessions/[id]/turn/` directory).

## Decisions Made
- **`per danni a` lead-in (corrects the spec):** verified that `extractPurpose` (`roll-parser.ts:748`) only captures the target into the button label with a `per`/`for` lead-in; the bare `danni a` form drops the target and breaks the stateless two-step. Emitting `Tira 1d6+<bonus> per danni a <name>` is symmetric with the existing attack format and round-trips (asserted via `parseRollRequests`).
- **Mirror, don't call the engine:** `resolveCombat` replicates `attack.ts:345/361/365` on the already-rolled total instead of importing `makeAttack`/`applyDamage` (which re-roll the d20 and need a full Character/resistance model the vault path lacks — D-09).
- **Case-insensitive EXACT match → server-side id:** `monsters.filter(m => m.name.toLowerCase() === target.toLowerCase())`; 0 or >1 → `null`. The player names a monster; the resolver derives the trusted `id`/`ac` (T-08-01).
- **Followed all locked CONTEXT decisions (D-02..D-05, D-08, D-10) and the spike-findings purity/determinism rules** (no `Date.now`/`Math.random`/`randomUUID`/`process.env`/fs in the resolver).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. Both verification gates (`pnpm vitest run …combat-resolver.test.ts` and `pnpm tsc --noEmit`) passed on the first run for each task. `tsc` was confirmed clean after both the source and the test file landed.

## User Setup Required
None - no external service configuration required. This phase installs no packages (T-08-SC: accept — pure TS reusing internal modules).

## Next Phase Readiness
- `resolveCombat` is ready to be hooked into the vault branch of `route.ts` **before** `runVaultToolLoop` (Plan 08-02): read the encounter early, gate on `vaultMutations && encounter.active && isRollResult(playerMessage)`, emit `resolver.events` via `dispatchVaultTool`, run the loop in narration-only mode with `resolver.narrationDirective`, and append `resolver.damageRequest` if the LLM omits it.
- The narration-only loop flag (`loop.ts`) and the D-07 directive suppression (`turn-directive.ts`) remain to be built in the Wave-2 plans (08-02/08-03) — out of scope here.
- No blockers. The resolver's `null`-on-fall-through contract keeps the non-combat turn path unchanged when wired.

## Self-Check: PASSED
- FOUND: src/app/api/sessions/[id]/turn/combat-resolver.ts
- FOUND: tests/app/api/sessions/[id]/turn/combat-resolver.test.ts
- FOUND commit: e80293f (Task 1)
- FOUND commit: 1722ac4 (Task 2)

---
*Phase: 08-server-side-combat-resolver-v1-player-attacks*
*Completed: 2026-05-29*
