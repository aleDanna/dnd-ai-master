---
phase: 08-server-side-combat-resolver-v1-player-attacks
plan: 02
subsystem: api
tags: [combat, vault, narration-only, turn-directive, double-apply, tdd, vitest, REQ-039]

# Dependency graph
requires:
  - phase: 06-vault-combat-state-foundation-d1
    provides: ENCOUNTER_EVENT_TYPES Set + monster_hp_change/turn_advance events + dispatchVaultTool emission path
  - phase: 07-vault-combat-playable-d2
    provides: buildTurnDirective + isRollResult + the 07-05 roll-result resolve directive (the re-ask-breaker D-07 suppresses)
  - phase: 08-server-side-combat-resolver-v1-player-attacks (plan 01)
    provides: pure resolveCombat contract (the authoritative server-side events these two guards protect from double-apply)
provides:
  - "VaultLoopInput.suppressCombatMutations flag — narration-only mode dropping ENCOUNTER_EVENT_TYPES apply_event calls at the loop dispatch seam (D-06)"
  - "TurnDirectiveOpts.serverResolved flag — D-07 suppression of ALL combat-mutation re-ask directives (resolve + combat-intent + general catalog) on a server-resolved turn"
  - "The two independent double-apply guards (T-08-04 mitigation) proven via unit/integration tests; belt-and-suspenders (don't ask + don't honor)"
affects: [08-03 route wiring — passes suppressCombatMutations:true + serverResolved + injects resolver.narrationDirective]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Narration-only loop mode: a server-resolution turn drops the LLM's encounter-event apply_event calls at the dispatch seam (emit start/end ok:true + benign tool_result, then continue — never reach dispatchVaultTool) so the model narrates without re-applying"
    - "Belt-and-suspenders integrity guard: directive suppression (don't ask for the events) + loop drop (don't honor them if asked anyway), scoped to ENCOUNTER_EVENT_TYPES only so non-combat mutations are untouched"

key-files:
  created: []
  modified:
    - "src/ai/master/vault/loop.ts"
    - "tests/ai/master/vault/loop.test.ts"
    - "src/ai/master/vault/turn-directive.ts"
    - "tests/ai/master/vault/turn-directive.test.ts"

key-decisions:
  - "suppressCombatMutations drops ONLY ENCOUNTER_EVENT_TYPES apply_event calls (combat_start/monster_spawn/initiative_set/turn_advance/monster_hp_change/combat_end); non-combat apply_event (hp_change, inventory_add) still dispatches (T-08-05)"
  - "The dropped call still emits tool_use_start + tool_use_end (ok:true) + a benign tool_result {ok:true, note:'combat resolved server-side this turn'} so the model's turn completes cleanly; the drop is placed AFTER toolCallCount += 1 so cap accounting matches a real dispatch"
  - "D-07 serverResolved suppresses ALL THREE combat-mutation re-ask directives, not just the isRollResult resolve branch: the roll-result echoes 'attaccare <target>' which trips detectCombatIntent (combat-start re-ask) and the general directive lists monster_hp_change in its catalog — all re-ask the very events the loop drops (deviation from the plan's literal 'fall through to combat-intent/general directive', required to satisfy the must_have and the T-08-04 integrity control)"
  - "Both flags are optional + default-falsy → Phase 07 behavior is byte-identical when absent (regression-protected); honored the spike-findings determinism rule (no Date.now/Math.random/process.env in turn-directive, REQ-022 prompt-affecting path)"

patterns-established:
  - "Optional JSDoc'd phase-tagged flag on an input interface (suppressCombatMutations on VaultLoopInput; serverResolved on TurnDirectiveOpts) following the existing dualWrite?/toolCallCap? convention"
  - "Dispatch-seam drop branch: gate on (flag && tu.name==='apply_event' && ENCOUNTER_EVENT_TYPES.has(input.type)) → emit start/end + benign result + continue, BEFORE dispatchVaultTool"

requirements-completed: [REQ-039]

# Metrics
duration: ~30min
completed: 2026-05-29
---

# Phase 08 Plan 02: Narration-Only Loop Mode + D-07 Directive Suppression Summary

**The two independent double-apply guards for server-side combat: `suppressCombatMutations` drops the LLM's encounter-event `apply_event` calls at the vault loop's dispatch seam (only `ENCOUNTER_EVENT_TYPES`; non-combat mutations still dispatch), and `serverResolved` suppresses every combat-mutation re-ask directive in `buildTurnDirective` — belt-and-suspenders against the Pitfall 3 / T-08-04 double-apply.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-05-29T21:08:35Z
- **Completed:** 2026-05-29
- **Tasks:** 2 (both TDD)
- **Files modified:** 4

## Accomplishments
- Added narration-only mode to `runVaultToolLoop`: a `suppressCombatMutations` flag that DROPS the LLM's combat-event `apply_event` tool calls at the dispatch seam (the server already emitted the authoritative events that turn), preventing the headline double-apply (monster takes 2× damage, turn double-advances).
- Scoped the drop precisely to `ENCOUNTER_EVENT_TYPES` — a non-combat `apply_event` (e.g. `hp_change`, `inventory_add`) still dispatches and persists (no collateral loss of legit mutations, T-08-05).
- Added D-07 `serverResolved` suppression to `buildTurnDirective`: on a server-resolved turn it suppresses ALL three combat-mutation re-ask directives (the resolve directive, the combat-intent combat-start directive, and the general apply_event catalog) so the prompt never asks the model to emit the events the loop is about to drop — belt-and-suspenders.
- Both guards are flag-gated and default-falsy, so the Phase 07 path is byte-identical when the flags are absent (regression-proven).
- 6 new tests (3 loop integration + 3 directive unit), all green; full vault suite 708 passing; `pnpm tsc --noEmit` clean.

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1: suppressCombatMutations narration-only mode (loop.ts)**
   - `c46f952` (test — RED: failing narration-only tests)
   - `77b5230` (feat — GREEN: drop branch + flag + ENCOUNTER_EVENT_TYPES import)
2. **Task 2: D-07 serverResolved suppression (turn-directive.ts)**
   - `7086539` (test — RED: failing suppression tests)
   - `0c070f1` (feat — GREEN: serverResolved flag gating all three re-ask directives)

_No REFACTOR commits — both implementations were minimal and matched the existing branch/emit shapes._

## Files Created/Modified
- `src/ai/master/vault/loop.ts` — Added `VaultLoopInput.suppressCombatMutations`, the `ENCOUNTER_EVENT_TYPES` import from `./events-schema`, and the dispatch-seam drop branch (emit start/end ok:true + benign tool_result + continue, scoped to encounter events).
- `tests/ai/master/vault/loop.test.ts` — New `describe('runVaultToolLoop — narration-only mode (Phase 08)')` with a `seedEncounterCampaign` helper (active encounter + character); 3 cases: (a) flag-on drops monster_hp_change (zero new lines, turn completes), (b) flag-off regression dispatches it (one new line), (c) flag-on non-combat hp_change still dispatches.
- `src/ai/master/vault/turn-directive.ts` — Added `TurnDirectiveOpts.serverResolved` and gated the `isRollResult` resolve branch, the combat-intent branch, and the general directive's apply_event catalog all on `!serverResolved`.
- `tests/ai/master/vault/turn-directive.test.ts` — New `describe('D-07 — server-resolved suppression')`: suppression (no monster_hp_change / no resolve header), regression (flag-absent still emits), determinism.

## Decisions Made
- **Drop placement + shape:** the drop branch sits at the TOP of the `for (const tu of toolUses)` body, AFTER `toolCallCount += 1` (so a dropped call is counted like a real one for cap consistency), and reproduces the existing emit shape (`tool_use_start`, then `tool_use_end` with `ok:true, rolls:[], mutationCount:0`) plus a benign JSON `tool_result`, then `continue` — it never reaches `dispatchVaultTool`, so `events.md` is untouched.
- **Scope = ENCOUNTER_EVENT_TYPES only:** verified via case (c) that a `hp_change` apply_event still dispatches under the flag — the drop is keyed on `ENCOUNTER_EVENT_TYPES.has(input.type)`, never on `apply_event` alone (would lose legit non-combat mutations — RESEARCH Anti-Pattern, T-08-05).
- **D-07 breadth (see Deviations):** the plan said "skip the isRollResult branch (fall through to combat-intent / general directive)", but a roll-result fixture trips `detectCombatIntent` (it echoes `attaccare <target>`) → the combat-start directive, and the general directive's catalog lists `monster_hp_change`. Both re-ask for the dropped events. To honor the must_have ("output does NOT contain `monster_hp_change`") and the T-08-04 integrity goal, all three re-ask directives are gated on `!serverResolved`; the directive falls through to the POV-only general block (2nd-person narration), and the route injects the server's authoritative narration directive separately (D-06).
- **Determinism preserved:** no `Date.now`/`Math.random`/`process.env` introduced; the `serverResolved` suppression is deterministic across 100 calls (asserted). REQ-022 byte-stability of the prompt-affecting path is intact.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/2 - Bug / Missing critical functionality] D-07 suppression must cover the combat-intent and general-catalog directives, not just the resolve branch**
- **Found during:** Task 2 (D-07 serverResolved suppression)
- **Issue:** The plan instructed: when `serverResolved`, skip ONLY the `isRollResult` resolve branch and "fall through to the rest of the function — combat-intent / general directive". But the D-07 must_have/acceptance criterion requires the output to NOT contain `'monster_hp_change'` on a server-resolved turn. The roll-result fixture (`🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).`) contains "attaccare", so `detectCombatIntent` returns true → falling through lands on the combat-start directive, which re-asks `combat_start`/`monster_spawn`/`monster_hp_change`/`turn_advance`. Gating only the combat-intent branch then fell through to the general directive, whose apply_event catalog also lists `monster_hp_change`. Either fall-through re-introduces the exact double-apply re-ask the suppression exists to prevent (T-08-04 — the headline integrity control).
- **Fix:** Gated all three combat-mutation re-ask directives on `!serverResolved` (the `isRollResult` resolve branch, the combat-intent combat-start branch, and the general directive's `vaultMutations` apply_event catalog). On a server-resolved turn `buildTurnDirective` returns the POV-only general directive (2nd-person narration guidance); the route injects `resolver.narrationDirective` separately (D-06), so the model still gets full combat-narration instruction without a conflicting "you call apply_event" re-ask.
- **Files modified:** src/ai/master/vault/turn-directive.ts
- **Verification:** `D-07 — server-resolved suppression` suite green (suppression: no `monster_hp_change`, no `ISTRUZIONE PRIORITARIA — il giocatore ha appena tirato`; regression: flag-absent still emits the resolve directive byte-identically); determinism asserted; full turn-directive suite 38/38; tsc clean.
- **Committed in:** `0c070f1` (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 1/2 — semantic correctness of the D-07 integrity guard)
**Impact on plan:** Necessary for the must_have and the T-08-04 double-apply mitigation. No scope creep — same file, same flag, same intent (the server's directive takes over the turn); the deviation only broadens WHICH re-ask directives the flag suppresses so none of them ask for the dropped events. Plan 08-03 wiring is unaffected (it passes `serverResolved` + injects the narration directive exactly as designed).

## Issues Encountered
- **Pre-existing unrelated test failure (out of scope):** `tests/sessions/applicator.test.ts > applyMutations > add_inventory + remove_inventory + set_equipped persist to characters.inventory` fails. Confirmed PRE-EXISTING — last touched by commit `7ad8533` (a multiplayer fix before Phase 08); no commit in the 08-02 range touched `applicator.test.ts` or `src/sessions/applicator.ts`. It is the `applicator/gp-stack` failure the 08-02 plan's verification section explicitly excludes. Not fixed (SCOPE BOUNDARY); logged to `08/deferred-items.md`. The vault + resolver surface this plan touches is fully green (vault 708/708 non-skipped; resolver 16/16).

## User Setup Required
None - no external service configuration required. This plan installs no packages (T-08-SC: accept — pure TS reusing internal modules; vitest already present).

## Next Phase Readiness
- Both guards are ready for Plan 08-03 to wire at the route: pass `suppressCombatMutations: true` into `runVaultToolLoop` on a resolution turn, pass `serverResolved: resolver !== null` into `buildTurnDirective`, and inject `resolver.narrationDirective` separately (D-06).
- The narration-only drop is unit-proven (drops only encounter events; non-combat dispatches; flag-off regression holds); D-07 suppression is unit-proven (suppresses the re-ask; regression holds).
- No blockers. Note for 08-03: on a server-resolved turn `buildTurnDirective(serverResolved:true)` now returns the POV-only general directive, so 08-03 must inject `resolver.narrationDirective` to carry the combat semantics (the directive intentionally no longer re-asks for apply_event).

## Self-Check: PASSED
- FOUND: src/ai/master/vault/loop.ts
- FOUND: tests/ai/master/vault/loop.test.ts
- FOUND: src/ai/master/vault/turn-directive.ts
- FOUND: tests/ai/master/vault/turn-directive.test.ts
- FOUND: .planning/phases/08-server-side-combat-resolver-v1-player-attacks/08-02-SUMMARY.md
- FOUND commit: c46f952 (Task 1 RED)
- FOUND commit: 77b5230 (Task 1 GREEN)
- FOUND commit: 7086539 (Task 2 RED)
- FOUND commit: 0c070f1 (Task 2 GREEN)

---
*Phase: 08-server-side-combat-resolver-v1-player-attacks*
*Completed: 2026-05-29*
