---
phase: 03-migration-cutover
plan: D-01
subsystem: infra
tags: [bench, m4, ollama, vault, vitest, tsx]

# Dependency graph
requires:
  - phase: 03-migration-cutover
    provides: spike 004 + 011 + 014 validated harnesses, MASTER_SUMMARIZATION wiring (03-B-05)
  - phase: 01-vault-read-path
    provides: REQ-021 M4 baseline section (Phase 01 SUMMARY) — D-02 will paste numbers here
provides:
  - pnpm bench-phase-03-m4 unified operator script
  - decision-grade JSON aggregating G1 + G2 + long-session + narrative quality stages
  - script-shape Vitest suite that mocks execSync (runs on M5 Pro CI)
  - explicit "manual" gate signaling that narrative quality requires operator human verdict
affects: [03-D-02, 03-C-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Operator orchestrator script: execSync over external spike harnesses + regex stdout parsing → aggregated JSON + table"
    - "Named module exports (parsers, runPipeline, constants) so a require.main === module guard keeps main() out of import-time"
    - "Mocked execSync via vi.mock for CI-side script-shape tests (no real bench on non-M4 hardware)"

key-files:
  created:
    - scripts/bench-phase-03-m4.ts
    - tests/scripts/bench-phase-03-m4.test.ts
  modified:
    - package.json

key-decisions:
  - "Stage 3 narrative-quality gate is `manual`, not `pass/fail` — spike 014 produces a markdown report for human ranking, no automated score (REQ-032 keeps Mistral as offline content tool, so the operator's verdict is the qualitative gate)"
  - "Stage 1 runs spike 004 ONCE (full sweep includes both compliance + walltime); parser pulls G1 and G2 from the same stdout"
  - "Stage 2 long-session uses 1.5× growth ratio between first-5 and last-5 turn avgs as the no-degradation gate (matches spike 011's keyword/wallclock methodology)"
  - "Parser exports made public so the unit suite tests the regexes against real-shaped log fragments rather than asserting on aggregated outputs alone"

patterns-established:
  - "Spike orchestrator: thin runner that captures stdout from existing spike harnesses, no inline logic duplication"
  - "Operator-vs-CI split: --dry-run flag lets non-M4 environments (CI, M5 Pro dev) sanity-check the runner without invoking the bench"

requirements-completed: [REQ-020, REQ-031, REQ-032]

# Metrics
duration: 6min
completed: 2026-05-27
---

# Phase 03 Plan D-01: Unified M4 Bench Runner Summary

**`pnpm bench-phase-03-m4` ships as a thin orchestrator over spikes 004 + 011 + 014, aggregating their stdout into a decision-grade JSON with G1/G2/long-session gates plus a manual narrative-quality gate.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-27T09:01:26Z
- **Completed:** 2026-05-27T09:07:00Z
- **Tasks:** 3
- **Files modified:** 3 (2 new, 1 edit)

## Accomplishments

- New unified runner (`scripts/bench-phase-03-m4.ts`, 410 LOC) orchestrates the three validated spike harnesses sequentially, captures their stdout, applies pass/fail gates per the ROADMAP success criteria, and writes a timestamped aggregated JSON to `.planning/phases/03-migration-cutover/bench-results/`
- Stage 2 receives `MASTER_SUMMARIZATION=on` in env so the long-session bench exercises the summarizer wired in plan 03-B-05 (the prompt-growth gate that motivated the summarizer in the first place)
- `--dry-run` flag prints the plan + gates without invoking any spike harness, so CI and M5 Pro dev can verify the runner shape (the actual bench is M4-only per REQ-020)
- `--out=<path>` flag overrides the default `bench-results/phase-03-m4-<ts>.json` output for ad-hoc operator workflows
- 24-case Vitest suite (`tests/scripts/bench-phase-03-m4.test.ts`, 130 ms total runtime) exercises every parser against real-shaped log fragments + drives `runPipeline` end-to-end with mocked `execSync` covering happy path, env wiring, failing G1, parser-error path, and Stage 2 throw

## Task Commits

1. **Task 1: Write `scripts/bench-phase-03-m4.ts`** — `aff684e` (feat)
2. **Task 2: Add `bench-phase-03-m4` script entry to package.json** — `e54fca7` (chore)
3. **Task 3: Script-shape Vitest suite + parser regex fix** — `9aa81f2` (test)

## Files Created/Modified

- `scripts/bench-phase-03-m4.ts` (NEW) — Unified orchestrator: CLI parsing, 4 regex parsers (warm wall-clock, lenient compliance, per-turn wall ms, narrative turn counts), `runPipeline` (3 spike stages + aggregation + JSON write), summary-table renderer, dry-run preview. Module guarded by `require.main === module` so tests can import the parsers + `runPipeline` directly without triggering `main()`.
- `package.json` (EDIT) — Added `"bench-phase-03-m4": "tsx scripts/bench-phase-03-m4.ts"` to the scripts block, next to the Phase 01 analog `bench-vault-m4`.
- `tests/scripts/bench-phase-03-m4.test.ts` (NEW) — 24 Vitest cases organized in 5 describe blocks (CLI parsing, parsers, runPipeline with mocked execSync, gate boundary values, fixture-tmpdir cleanup sanity). Real spike harnesses are NOT invoked — fixtures are lifted from `.planning/spikes/00{4,11,14}/results/*.log` and `run-session.ts` line 204.

## Decisions Made

1. **Stage 3 (narrative) is a `manual` gate, not `pass/fail`.** Spike 014's output is a markdown report scored by a human (rank 1-4 across 4 models × 5 scenarios). There is no automated 5-keyword score in the harness, so claiming a `>=4/5` numeric gate would have been a parser fiction. The runner instead asserts "all 20 scenarios completed" and surfaces `gate: 'manual'` so the operator knows the bench is decision-incomplete until they fill the rank table in `comparison-*.md`. This matches the spike 014 README's explicit "this is a markdown report meant for HUMAN evaluation" framing.
2. **Stage 1 runs spike 004 once and parses both metrics from the same stdout.** Spike 004 is itself a sweep (compliance phase → walltime phase across 5 models). Re-running it twice for G1 and G2 separately would double the M4 wall-clock cost. The single execSync produces both numbers and the parser pulls them from distinct log markers (`WARM ... vault: wall=Nms` for G1, `lenient=N/M (PCT%)` for G2).
3. **Stage 2 growth gate uses 1.5× ratio between first-5-turn avg and last-5-turn avg.** This matches the spike 011 methodology (per-turn wall ms tracked, no per-turn target — the gate is "doesn't degrade as the prompt grows"). A strict `lastAvg < firstAvg * 1.5` is conservative enough that real prompt-growth drift would trip it, but tolerant enough that natural per-turn variation doesn't false-fail.
4. **Parsers exported as public module API.** `runPipeline` could test the regexes transitively via `runPipeline` calls, but exporting them lets the suite assert each parser independently with focused fixtures. This caught the Rule 1 bug below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `parseTurnWallTimes` regex did not tolerate whitespace padding**

- **Found during:** Task 3 (test suite execution exposed two failures rooted in the same regex)
- **Issue:** Initial regex `\[turn\s+\d+\]\s+wall=(\d+)ms` required `wall=` to be immediately followed by digits, but the real spike 011 harness right-pads the ms value with `.padStart(6)` (run-session.ts line 204), producing lines like `[turn  1] wall=  4227ms` with two leading spaces. The hand-written canonical sample in the plan used `wall=4227ms` (no padding), masking the bug until the suite asserted on a fixture that matched the real harness output.
- **Fix:** Relaxed pattern to `\[turn\s+\d+\]\s+wall=\s*(\d+)\s*ms` (allow optional whitespace either side of the digit run).
- **Files modified:** `scripts/bench-phase-03-m4.ts` (parser regex + adjacent comment citing `run-session.ts:204`)
- **Verification:** All 24 test cases pass after the fix; the previously failing `parseTurnWallTimes extracts all 10 per-turn wall ms values in order` and the `happy path: all 3 stages pass` cases both green.
- **Committed in:** `9aa81f2` (Task 3 commit, alongside the new test file)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Bug was internal to the runner — caught by the very suite the plan asked for. No scope creep, no architectural change. The fix is purely a regex relaxation that strengthens the parser's match against real harness output.

## Issues Encountered

None — straight-line execution. The 1 deviation above was a self-inflicted regex tightness, caught by the test suite within the same task and fixed inline.

## User Setup Required

None — no external service configuration required. The runner is operator-invoked on existing M4 hardware with the same Ollama daemon + pulled models that the spike harnesses already require.

## Next Phase Readiness

- **For plan 03-D-02:** The operator runs `pnpm bench-phase-03-m4` on the Mac Mini M4 (with Ollama up and the 5 candidate models + `dnd-master-plus:latest` baseline pulled), reviews the printed summary table + the aggregated JSON under `.planning/phases/03-migration-cutover/bench-results/`, and pastes the measured numbers into the Phase 01 SUMMARY.md "M4 target hardware" table per the 03-D-02 plan instructions.
- **For plan 03-C-04 (baked variant decommission):** Per Pitfall 7, 03-C-04 must NOT land until plan 03-D-02 has confirmed the bench passed — the bench's Stage 1 walltime sweep compares vault candidates against `dnd-master-plus:latest` as the A/B baseline, and 03-C-04 retires that baseline.
- **Test-harness regression watch:** If the spike 011 harness changes its per-turn log format (e.g., drops the `.padStart(6)`), the test suite's fixture-based assertions will flag it; the runner's regex (relaxed to tolerate whitespace) should still match. If spike 004's `WARM` / `lenient=` markers ever change, the parsers will return null and the gate will surface as `error`, not `fail` — explicit signal that parser drift, not bench regression, broke the metric.

## Self-Check: PASSED

Verified after writing SUMMARY:

- `scripts/bench-phase-03-m4.ts`: FOUND
- `tests/scripts/bench-phase-03-m4.test.ts`: FOUND
- `package.json` contains `bench-phase-03-m4`: FOUND
- Commit `aff684e` (Task 1): FOUND
- Commit `e54fca7` (Task 2): FOUND
- Commit `9aa81f2` (Task 3): FOUND
- `pnpm typecheck`: PASS (clean)
- `pnpm test tests/scripts/bench-phase-03-m4.test.ts`: PASS (24/24, 131 ms)
- `pnpm bench-phase-03-m4 --dry-run`: PASS (prints 3 stages + gates, no spike invocation)
- `grep -c "execSync" scripts/bench-phase-03-m4.ts`: 3 (≥ 3 required)
- `grep -c "spikes/004\|spikes/011\|spikes/014" scripts/bench-phase-03-m4.ts`: 4 (3 unique spike refs + 1 comment)
- `grep -c "MASTER_SUMMARIZATION" scripts/bench-phase-03-m4.ts`: 3 (≥ 1 required — Stage 2 env)
- `grep -c "bench-phase-03-m4" package.json`: 1 (exactly 1 required)
- Output JSON path matches `.planning/phases/03-migration-cutover/bench-results/`: FOUND
- Exit code 1 on overall fail: `process.exit(report.overallPass ? 0 : 1)` present on line 392

---

*Phase: 03-migration-cutover*
*Completed: 2026-05-27*
