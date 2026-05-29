# Phase 08 — Deferred Items

Out-of-scope discoveries logged during execution (NOT fixed — pre-existing or
unrelated to the current plan's changes).

## Pre-existing test failure (logged during plan 08-02)

- **Test:** `tests/sessions/applicator.test.ts > applyMutations > add_inventory + remove_inventory + set_equipped persist to characters.inventory`
- **Status:** PRE-EXISTING — fails on the baseline before 08-02 (commit `3448887`).
  Last commit touching `applicator.test.ts` is `7ad8533` (a multiplayer slot/resource
  fix from before Phase 08); no commit in the 08-02 range touched `applicator.test.ts`
  or `src/sessions/applicator.ts`.
- **Why out of scope:** Inventory/equipment persistence — unrelated to the combat
  resolver / vault loop / turn directive surface that 08-02 modifies. The 08-02 plan's
  verification section explicitly excludes it ("no regression … beyond the pre-existing
  `applicator/gp-stack` failure noted in 07-03").
- **Action:** None taken (SCOPE BOUNDARY). Surfaced here for the verifier / a future
  inventory-focused plan.
