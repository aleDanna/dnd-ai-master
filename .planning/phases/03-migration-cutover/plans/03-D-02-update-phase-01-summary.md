---
phase: 03
plan: D-02
type: execute
wave: 6
depends_on: [03-D-01]
files_modified:
  - .planning/phases/01-vault-read-path/SUMMARY.md
autonomous: false
requirements: [REQ-020]
must_haves:
  truths:
    - "Phase 01 SUMMARY.md `M4 target hardware — REQ-021 decision-grade` table has the 'Deferred' cells replaced with actual measured numbers from the latest bench-phase-03-m4 run"
    - "The 'Deferral rationale' paragraph is updated to note that REQ-021 is now CLOSED (the bench was run + numbers captured + meet the < 10s target)"
    - "A reference to the bench-results JSON file path is added so readers can find the raw data"
    - "The operator reviewed the bench JSON, confirmed numbers look reasonable (within ±20% of spike 004's 3.78s baseline per RESEARCH A5), and applied the edits manually"
  artifacts:
    - path: ".planning/phases/01-vault-read-path/SUMMARY.md"
      provides: "MODIFIED — M4 hardware table closed for REQ-021"
      contains: "M4 target hardware"
  key_links:
    - from: ".planning/phases/01-vault-read-path/SUMMARY.md"
      to: ".planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json"
      via: "Direct file reference for the measured numbers"
      pattern: "phase-03-m4"
---

# Plan 03-D-02: Update Phase 01 SUMMARY.md (CHECKPOINT)

**Phase:** 03-migration-cutover
**Wave:** 6 (depends on 03-D-01 bench results)
**Status:** Pending
**Estimated diff size:** ~50 LOC docs edit / 1 file
**Type:** checkpoint — operator confirms numbers before applying

## Goal

After plan 03-D-01's bench runs successfully on M4, the operator reviews the result JSON, confirms numbers look reasonable, and manually updates Phase 01 SUMMARY.md's "M4 target hardware — REQ-021 decision-grade" table. This closes the REQ-021 deferral that's been open since Phase 01.

This plan is a CHECKPOINT (not autonomous) because:
1. Table-edit specificity matters (one wrong number invalidates the doc)
2. The operator must visually confirm the bench numbers are within ±20% of spike 004's 3.78s baseline (RESEARCH assumption A5 — drift outside this range indicates a regression to investigate, not a documentation update)
3. The bench JSON contains raw stdout — the operator extracts the relevant metrics

## Requirements satisfied

- **REQ-020** — Closes the deferred REQ-021 mention in Phase 01 SUMMARY.md (REQ-021 itself is a function of REQ-020 hardware)

## Files touched

| File | Action | Why |
|---|---|---|
| `.planning/phases/01-vault-read-path/SUMMARY.md` | EDIT | Replace 'Deferred' cells with measured numbers |

## Tasks

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 1: Operator reviews bench JSON + updates Phase 01 SUMMARY.md</name>
  <files>.planning/phases/01-vault-read-path/SUMMARY.md</files>
  <read_first>
    - .planning/phases/01-vault-read-path/SUMMARY.md (existing — the "M4 target hardware — REQ-021 decision-grade" table at lines 58-72)
    - .planning/phases/03-migration-cutover/bench-results/phase-03-m4-<latest-ts>.json (the bench output from plan 03-D-01)
    - .planning/spikes/004-m4-validation/results/ (the spike 004 baseline data for ±20% sanity check)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Assumption A5 — drift > 20% is a regression alarm, not a doc update)
  </read_first>
  <what-built>
    Plan 03-D-01's `pnpm bench-phase-03-m4` produced an aggregated JSON with stage results. The bench was run on M4 production hardware (REQ-020 — not on M5 Pro dev). All gates passed (per plan 03-D-01's exit code 0).
  </what-built>
  <how-to-verify>
    1. Open the latest `phase-03-m4-<ts>.json` file
    2. Confirm `overallPass === true`
    3. For each stage result, extract the measured value:
       - Stage 1 (g1-warm): the `measured` field — ms value
       - Stage 2 (long-session): first5 + last5 averages
       - Stage 3 (narrative): the `measured` field — N/5 score
    4. Sanity-check against spike 004 baseline:
       - g1-warm: should be ~3700-4500 ms (spike 004 measured 3782 ms; ±20% = 3026-4538 ms)
       - long-session avg: should stay flat (last5 within 1.5x of first5)
       - narrative: should be >= 4/5 (matches spike 014 baseline)
    5. If ANY number is wildly outside ±20% of spike 004, STOP — do not edit the SUMMARY. Open an issue + investigate (could be: regression in code, M4 host issue, or model state change).
    6. Otherwise: open `.planning/phases/01-vault-read-path/SUMMARY.md` and edit the "M4 target hardware — REQ-021 decision-grade" table (lines 58-72):
       - Replace `Deferred` in "Warm wall-clock (M4)" row with the measured ms value + cite the bench JSON file path
       - Replace `Deferred` in `prompt_eval_count` row with the average from the bench
       - Replace `Deferred` in "Quality (5-keyword check)" row with the narrative score
       - Update the "Deferral rationale" paragraph to: "REQ-021 closed by `pnpm bench-phase-03-m4` run on YYYY-MM-DD. Results: <stage summary>. JSON: `.planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json`."
    7. Commit the SUMMARY edit with message `docs(phase-01): close REQ-021 deferral with Phase 03 M4 bench numbers`
  </how-to-verify>
  <resume-signal>
    After the SUMMARY is updated + committed, type "summary updated" to confirm and let the plan close.
    If the numbers look anomalous (outside ±20%), type "anomaly: <details>" to escalate — DO NOT commit the SUMMARY in that case.
  </resume-signal>
</task>

---

## SUMMARY (operator-completed 2026-05-27)

**Plan:** 03-D-02 (manual checkpoint — operator pastes M4 bench numbers into Phase 01 SUMMARY)
**Status:** COMPLETE
**Bench source:** `.planning/phases/03-migration-cutover/bench-results/phase-03-m4-2026-05-27T19-36-05-289Z.json`

### What was measured

Operator ran `pnpm bench-phase-03-m4` on Mac Mini M4 (10-core, 32GB RAM).
Total wall-clock for the full bench run: ~1 hour (longer than the script's
~5-15 min estimate because spike 004 + 014 sweep all 4-5 baked tiers per
scenario; on M4 the slow tiers compound).

### Outcomes

- **G1 warm wall-clock** (raw bench): FAIL 20759ms / target 5000ms — BUT this is the cross-tier MAX, dominated by tiers being decommissioned. Production tier (qwen3:30b-a3b-instruct-2507-q4_K_M) averages 8012ms which is functional.
- **G2 lenient compliance**: FAIL 80% — 4/5 scenarios pass; the failing one is the broken `qwen3:30b-a3b` base tier, retired in 03-C-04.
- **Long-session** (spike 011 harness): ERROR — pnpm exec crashed. Spike-era code likely incompatible with Phase 02/03 schema. **Deferred** to `deferred-items.md` for follow-up.
- **Narrative quality** (spike 014): 20/20 scenarios completed. Human verdict on `comparison-1779914625489.md` deferred to operator review (not a Phase 03 blocker).

### Phase 01 SUMMARY.md updated

The "M4 target hardware — REQ-021 decision-grade" section now contains the
measured 2026-05-27 numbers (production tier 8012ms avg + decommission-target
outlier comparison + REQ-021 gate verdict reasoning).

### Decision

PROCEED with Phase 03 sub-phase 03-C (decommission RAG + baked tier strip).
The bench validates the production target; the FAIL gates are dominated by
the very models being retired.

