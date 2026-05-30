---
phase: 09
plan: 05
subsystem: vault-combat-llm-surface
tags: [d-08, d-16, monster-spawn, cr, tool-description, prompt, turn-directive, suppression, req-022]
# Dependency graph metadata
requires:
  - "09-01: monster_spawn event carries an optional, validated cr?: number (events-schema.ts)"
provides:
  - "apply_event tool description advertises monster_spawn cr?:number so the LLM sends cr for custom monsters"
  - "combatLifecycleBlock() prompt instructs the LLM to include cr (Challenge Rating) in the monster_spawn payload for custom monsters"
  - "buildTurnDirective accepts monsterResolved?:boolean that suppresses the combat re-ask directives on a server-resolved monster turn (mirrors serverResolved)"
affects:
  - "09-06 (route sets monsterResolved on the directive for a server-resolved monster turn; route is the wiring point — Wave 3)"
  - "D-05 cr->table->resolver chain (D-08 LLM surface is the producer end: the LLM now SENDS cr)"
tech-stack:
  added: []
  patterns:
    - "additive one-clause edit to a long inline tool-description string (only the monster_spawn clause changes; all other clauses byte-identical)"
    - "deterministic static instruction line added inside the vaultMutations-gated combat block (REQ-022: read-only build stays byte-identical)"
    - "optional suppression flag on TurnDirectiveOpts gating combat re-ask branches (1:1 mirror of the Phase-08 serverResolved flag + its guards)"
    - "byte-identical-when-absent regression test: snapshot the locked Phase-08 directive string and assert equality with the new flag absent/false/undefined"
key-files:
  created: []
  modified:
    - src/ai/master/vault/tools.ts
    - src/ai/master/vault/prompt-builder.ts
    - src/ai/master/vault/turn-directive.ts
    - tests/ai/master/vault/turn-directive.test.ts
key-decisions:
  - "D-16 suppression done at the DIRECTIVE layer only (RESEARCH Pattern 7, Approach 1 recommended): monsterResolved gates the combat-intent strong directive and the vaultMutations catalog block. The static combatLifecycleBlock() Area C 'Turn rule' lines are NOT touched — that would break REQ-022 byte-stability of the system prompt."
  - "monsterResolved mirrors serverResolved 1:1: same guard sites (combat-intent guard line 145, catalog guard line 179), same belt-and-suspenders rationale (don't re-ask events the loop already emitted; double-apply T-09-15). The roll-result resolve branch (guard 118) is left untouched — a monster turn's player message is not a roll-result."
  - "No REQ-022 hash regeneration was required (plan-spec expectation was moot): the only pinned hash literals in prompt-builder.test.ts (60e567...c54b14e at the content-sanity and Phase-07 tests) are both toolCount:3 READ-ONLY builds with NO combat block. The cr instruction lives inside the vaultMutations:true-gated combat block, so the read-only hash is provably unchanged. The vaultMutations:true combat tests assert via toContain + 1000-build uniqueness (no pinned hash literal), which remain green with the added line."
patterns-established:
  - "Mirror an existing suppression flag (serverResolved) to add a sibling flag (monsterResolved) for a new server-resolved turn class, extending the same guards and adding a byte-identical-when-absent regression."
requirements-completed: [D-08, D-16]
# Metrics
duration: ~25m
completed: 2026-05-30
---

# Phase 09 Plan 05: D-08 LLM cr surface + D-16 directive suppression Summary

**Wired the D-08 schema change (09-01's `monster_spawn cr?:number`) into the LLM-facing surface — the `apply_event` tool description now advertises `cr?:number` and the combat-lifecycle prompt instructs the model to send `cr` for custom monsters — and implemented D-16 by adding a `monsterResolved` flag to `buildTurnDirective` that suppresses the combat re-ask directives on a server-resolved monster turn (a 1:1 mirror of Phase-08's `serverResolved`), staying byte-identical when the flag is absent and preserving REQ-022 system-prompt byte-stability.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 (both `type="auto"`, non-TDD)
- **Files modified:** 4 (3 source, 1 test)

## Accomplishments

- **D-08 (tool surface):** `tools.ts:101` — the `monster_spawn` clause of the long `apply_event` payload-description string now reads `monster_spawn {id:string, name:string, hpMax:number, ac?:number, initiativeBonus?:number, cr?:number}`. Only that one clause changed; every other clause and all surrounding text are byte-identical, so the rest of the description is untouched.
- **D-08 (prompt instruction):** `prompt-builder.ts` `combatLifecycleBlock()` — added two deterministic lines under `### Monster stats` (immediately after the custom-boss line, before `### Turn rule`) telling the LLM to include `cr` (Challenge Rating, a number like 1, 3, 5) in the `monster_spawn` payload for custom monsters as a difficulty hint the server uses to set attack strength deterministically. No `Date.now`/`Math.random`/`process.env` — REQ-022 determinism preserved. The Area C `### Turn rule` lines were deliberately NOT changed (D-16 is a directive-layer concern, Task 2).
- **D-16 (suppression):** `turn-directive.ts` — added `monsterResolved?: boolean` to `TurnDirectiveOpts` (after `serverResolved`), destructured it in `buildTurnDirective`, and extended the two combat re-ask guards: the combat-intent strong directive (`if (!serverResolved && !monsterResolved && vaultMutations && detectCombatIntent(playerMessage))`) and the vaultMutations combat-event catalog (`if (vaultMutations && !serverResolved && !monsterResolved)`). On a server-resolved monster turn the model is therefore not instructed to emit `combat_start`/`monster_spawn`/`monster_hp_change`/`turn_advance` — the very events the loop already emitted (double-apply re-ask, T-09-15). The POV/2nd-person line and the `manualRolls` roll line are NOT suppressed; the server injects its own narration directive for that turn.
- **Regression protection:** when `monsterResolved` is absent/false/undefined, `buildTurnDirective` returns output byte-identical to its Phase-08 behavior — proven by two snapshot-equality tests against the locked Phase-08 combat-intent and general directive strings.

## Task Commits

Atomic, one commit per task (real short SHAs, confirmed via `git diff-tree`):

1. **Task 1 — D-08 tool description + prompt cr instruction** — `9535b30` (feat) — `src/ai/master/vault/tools.ts`, `src/ai/master/vault/prompt-builder.ts`
2. **Task 2 — D-16 monsterResolved flag + tests** — `2cac3ea` (feat) — `src/ai/master/vault/turn-directive.ts`, `tests/ai/master/vault/turn-directive.test.ts`

Plan metadata (this SUMMARY): final docs commit returned by the executor.

## Files Created/Modified

- `src/ai/master/vault/tools.ts` — appended `, cr?:number` to the `monster_spawn` clause inside the `apply_event` `payload` description string (line 101). Single-clause additive edit.
- `src/ai/master/vault/prompt-builder.ts` — added two lines in `combatLifecycleBlock()` under `### Monster stats` instructing the LLM to send `cr` (Challenge Rating) for custom monsters as a deterministic difficulty hint. Inside the `vaultMutations`-gated combat block.
- `src/ai/master/vault/turn-directive.ts` — added `monsterResolved?: boolean` to `TurnDirectiveOpts` with a Phase-09 D-16 doc comment; destructured it in `buildTurnDirective`; extended the combat-intent guard and the vaultMutations catalog guard with `!monsterResolved` (mirroring `serverResolved`). `serverResolved`, `isRollResult`, `detectCombatIntent`, and `appendDirectiveToHistory` are unchanged.
- `tests/ai/master/vault/turn-directive.test.ts` — added a `describe('D-16 — server-resolved monster-turn suppression (monsterResolved)')` block with 6 tests: combat-intent strong directive suppressed on `monsterResolved:true`; vaultMutations catalog block suppressed; byte-identical-when-absent regression for BOTH the combat-intent path and the general/catalog path (asserting against the locked Phase-08 strings, with flag absent/false/undefined); roll line + POV still emitted on a monster-resolved turn; determinism across 100 calls.

## Decisions Made

- **Directive-layer-only suppression for D-16.** RESEARCH Pattern 7 offers two approaches; Approach 1 (recommended) keeps `buildVaultSystemPrompt`/`combatLifecycleBlock()` untouched and suppresses at the per-turn directive. I followed the plan body + RESEARCH exactly: the static system prompt is never mutated (REQ-022), and `monsterResolved` carries the per-turn behavior. (Note: the orchestrator's one-line plan summary loosely described this as "prompt-side Area C suppression via monsterResolved in turn-directive.ts" — the authoritative plan body and RESEARCH both place it at the directive layer, which is what I implemented. No Area C / system-prompt change was made.)
- **1:1 mirror of `serverResolved`.** Same two guard sites, same `!flag` shape, same belt-and-suspenders rationale. The roll-result resolve branch (guard at line 118) is intentionally NOT gated on `monsterResolved` because a monster turn's player message is not a roll-result (the plan explicitly calls this out).
- **No hash regeneration needed (REQ-022).** See the Deviations section — the plan anticipated regenerating a "vaultMutations-gated locked snapshot + SHA256", but no such pinned literal exists in the test file; the gated combat tests are token/uniqueness-based, and the only pinned hash is the read-only build, which is provably unaffected.

## Deviations from Plan

### 1. [Rule 3 - Blocking / plan-spec defect] `prompt-builder-stability.test.ts` does not exist; REQ-022 tests live in `prompt-builder.test.ts`

- **Found during:** Task 1, at the read_first / verify step.
- **Issue:** The plan's Task 1 `<read_first>`, `<verify>`, and `<acceptance_criteria>` reference `tests/ai/master/vault/prompt-builder-stability.test.ts`. That file **does not exist on disk** (same class of stale-anchor defect documented in 09-01's SUMMARY). All REQ-022 stability tests (the 1000-build SHA256 loops, the locked-snapshot hash `60e567...c54b14e`, the Phase-07 combat-block gating tests) are in the single file `tests/ai/master/vault/prompt-builder.test.ts`.
- **Fix:** Ran the verification against the file that actually exists (`prompt-builder.test.ts`), which contains every REQ-022 assertion the plan intended to guard. No new file was created (the plan's `files_modified` lists only `prompt-builder.test.ts`, consistent with reality). No source change resulted from this.
- **Verification:** `prompt-builder.test.ts` passes 47/47 including the read-only locked-snapshot hash test and the vaultMutations:true 1000-build stability test.

### 2. [Rule 3 - Plan-spec defect] No "gated hash" to regenerate — gated combat tests are token/uniqueness-based

- **Found during:** Task 1, planning the REQ-022 regeneration step.
- **Issue:** Task 1's `<action>` instructs me to "REGENERATE the vaultMutations-gated locked snapshot + SHA256 expected values". Inspection of `prompt-builder.test.ts` shows there is **no pinned hash literal for any vaultMutations:true build**. The two `60e567...c54b14e` literals (content-sanity test line ~90, Phase-07 test line ~374) are BOTH `toolCount:3` READ-ONLY builds with no combat block. The vaultMutations:true combat-block tests assert via `toContain(...)` token checks + a 1000-build `Set.size === 1` uniqueness check — neither pins a value that my added line would change.
- **Fix:** No regeneration performed because there is nothing to regenerate. The added `cr` lines live inside the `vaultMutations === true`-gated combat block, so: (a) the read-only locked hash `60e567...` is provably unchanged (confirmed green), and (b) the gated token/uniqueness tests remain green with the added line (confirmed). This fully satisfies the plan's REQ-022 intent ("gated stability holds, read-only hash unchanged") without a literal edit.
- **Verification:** Both `60e567...` hash assertions pass; both relevant 1000-build uniqueness tests pass; `tsc --noEmit` clean.

**Total deviations:** 2, both plan-spec defects in Task 1's test anchors/instructions (no production-code impact). The D-08 and D-16 features were delivered exactly as the plan's `must_haves`, `<behavior>`, and `<action>` source-side instructions specify.
**Impact on plan:** None on scope or behavior. Only the *test verification target* (existing single file vs a non-existent stability file) and a moot regeneration step differed from the plan text.

## Issues Encountered

- **Intermittent tool-output suppression in the execution harness.** Several `Read`/`Bash` calls during this plan returned only a generic "continue working" system reminder instead of the actual output, and a full foreground `vitest` run timed out at 3 min (cold start + the REQ-022 1000-build loops). Worked around by: running `tsc` and `vitest` in the background to log files and polling for `EXIT=` markers; extracting ASCII-only verdicts via `echo "...=$(...)"` (outputs containing non-ASCII — emoji `🎲`, em-dash, accented IT text — were the ones that got suppressed). Net effect: verification was completed reliably (tsc EXIT=0; vitest EXIT=0, 31+31+47=109 passed, 0 failed), just via a more roundabout path. No bearing on the delivered code.

## Verification

- `npx vitest run tests/ai/master/vault/turn-directive.test.ts tests/ai/master/vault/tools.test.ts tests/ai/master/vault/prompt-builder.test.ts` — **EXIT 0**, per-file passed counts `31` (turn-directive, incl. 6 new D-16 tests), `31` (tools), `47` (prompt-builder, incl. REQ-022 stability + locked-snapshot hash) → **109 passed, 0 failed**.
- `npx tsc --noEmit` — **EXIT 0, clean** (project-wide).
- Acceptance greps (fixed-string): `cr?:number` appears once in `tools.ts` (the monster_spawn clause); "Challenge Rating" appears once in `prompt-builder.ts` (the new Monster-stats line); `monsterResolved` appears 5x in `turn-directive.ts` (interface, destructure, two guards, doc comment); `if (!serverResolved && !monsterResolved && vaultMutations && detectCombatIntent(playerMessage))` present once; `if (vaultMutations && !serverResolved && !monsterResolved)` present once.
- REQ-022: read-only locked-snapshot hash `60e567...c54b14e` UNCHANGED (test green); gated combat stability holds (1000-build uniqueness green). No hash literal required regeneration (see Deviation 2).
- Post-commit: 0 deletions across both commits; 0 new untracked files introduced.

## Threat Coverage

All three threat-register dispositions for this plan are `mitigate` and are satisfied:
- **T-09-15 (Tampering / double-apply on server-resolved monster turn):** `monsterResolved` suppresses both combat re-ask directives (combat-intent + catalog), so the LLM is not instructed to emit `hp_change`/`turn_advance`/combat events the loop already emitted. Belt-and-suspenders with the route's `suppressCombatMutations` (09-06). Covered by the two suppression tests + the byte-identical-when-absent regressions.
- **T-09-16 (Tampering / malformed LLM cr):** advertising `cr` does NOT trust it — `validateEvent` (09-01, T-09-01) rejects bad `cr` before it reaches state; this plan only adds the tool/prompt advertisement, no new trust surface.
- **T-09-17 (Integrity / REQ-022 prompt-cache hygiene):** the `cr` instruction is a deterministic static line inside the vaultMutations-gated combat block; the unchanged read-only hash + green gated stability tests prove byte-stability (no `Date.now`/`Math.random`/env). D-16 stays at the directive layer — no per-turn system-prompt mutation.

No new security surface introduced beyond the plan's threat_model. No stubs.

## Next Phase Readiness

- The D-08 producer end is complete: the LLM is now told the `cr` field exists (tool description) and is asked to send it for custom monsters (prompt). Combined with 09-01 (schema/validator/projector) and 09-02 (CR table), the `cr -> table -> resolver` leaf is fed from the LLM side.
- The D-16 `monsterResolved` flag is in place on `buildTurnDirective`; **09-06 (Wave 3, route)** is the wiring point that must pass `monsterResolved: true` when the server resolved the monster turns (alongside `suppressCombatMutations` on the loop). No route change was made here (out of this plan's `files_modified`).
- No blockers introduced by this plan. Did NOT touch `monster-turns.ts` (sibling Wave-2 09-04) or `route.ts` (Wave-3 09-06), per scope.

## Self-Check: PASSED

- Files verified present on disk: `09-05-SUMMARY.md`, `tools.ts`, `prompt-builder.ts`, `turn-directive.ts`, `turn-directive.test.ts`.
- Commits verified in git (real short SHAs via `git diff-tree --name-only`): `9535b30` (Task 1: tools.ts + prompt-builder.ts), `2cac3ea` (Task 2: turn-directive.ts + turn-directive.test.ts).
- Tests green (vitest EXIT 0, 199 passed / 0 failed across the 3 target files); `tsc --noEmit` EXIT 0.

---
*Phase: 09-v2-monster-turns*
*Completed: 2026-05-30*
