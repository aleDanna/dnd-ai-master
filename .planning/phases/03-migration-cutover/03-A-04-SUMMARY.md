---
phase: 03-migration-cutover
plan: A-04
subsystem: api
tags: [vault, apply_event, tool-definitions, validateEvent, LLM-prompting, REQ-006, REQ-010]

# Dependency graph
requires:
  - phase: 03-migration-cutover
    provides: "Wave 2 extension of VaultEvent union (plan 03-A-02) — adds 20 new event types to events-schema.ts; validateEvent absorbs them transparently. apply_event dispatcher inherits the new types via the already-shipped validateEvent call (no dispatcher logic changes needed)."
provides:
  - "Extended apply_event tool description in VAULT_TOOL_DEFINITIONS — LLM-facing surface now lists all 27 mutation event types (7 Phase 02 + 20 Phase 03) with concise per-type payload shape hints"
  - "Dispatch-layer regression coverage for every Phase 03 event type — 20-row table-driven happy path + 16 rejection cases covering NIT 1 UUID guard, schema bounds, enum values, type-name spelling"
  - "Cross-check that Phase 02 dispatch behavior is preserved (51 baseline tests still green) and that REQ-010 4-tool surface is unchanged"
affects:
  - 03-A-09-dual-writer-class
  - 03-A-10-wire-dual-writer-in-turn-route
  - 03-B-04-condense-module

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tool-description-as-LLM-contract: every payload field constraint mirrored 1:1 from validateEvent into the description JSON-schema slot, so the model sees the same bounds the server enforces"
    - "Table-driven dispatch tests: it.each over canonical payloads from events-schema.ts, asserting only the dispatcher contract (events.md grew by 1 + JSON envelope shape) — leaves reducer-specific frontmatter assertions to projector.test.ts"

key-files:
  created:
    - ".planning/phases/03-migration-cutover/03-A-04-SUMMARY.md"
  modified:
    - "src/ai/master/vault/tools.ts (apply_event description + JSDoc Phase 03 note)"
    - "tests/ai/master/vault/tools.test.ts (44 new test cases in a single describe block)"

key-decisions:
  - "Tool description carries the full per-type payload table inline (rather than referencing /tools/index.md). NIT 8 prompt-size tradeoff: ~1.2KB added to every turn's system prompt. The explicit-in-description form puts the payload contract in front of the LLM on every turn, matching spike 009's 'explicit beats implicit' principle. Future work can extract to a one-time doc if prompt_eval_count becomes a bottleneck."
  - "Dispatch-test assertions stop at the dispatcher boundary: result.isError===false + events.md grew + {ok, event_id} envelope. View-content updates for Phase 03 fields are projector.test.ts's responsibility (03-A-03). This kept the test block deterministic across the Wave 3 parallel-execution timeline (the projector reducer arms may or may not be in HEAD when these tests run; either way the dispatch contract holds)."
  - "Roster matches the COMPLETENESS-AUDIT.md hard-count of 20 events — does NOT include level_up or class_level_add (those were classified provisional in the audit and were NOT shipped in 03-A-02's union). Mentioning them in the tool description would cause the dispatcher to reject them with 'unknown event type' (validateEvent does not know them), which would be a footgun."

patterns-established:
  - "Pattern 1: Tool-description payload-shape table — when adding event types to a discriminated-union tool, mirror the validateEvent bounds (slug length caps, numeric ranges, enum members) directly into the input_schema's description field. The LLM reads this as part of the system prompt; symmetry with server-side validation prevents 'looks valid to the model but rejected by the dispatcher' loops."
  - "Pattern 2: Dispatch-test event-counter helper — encapsulate `events.md` line-count probes (`eventCount()` here) and JSON envelope parsing (`parseDispatchOk()` here) as scoped helpers inside the describe block. Avoids the boilerplate of reading + splitting + filtering for every assertion, and keeps the table-driven `it.each` rows readable."

requirements-completed: [REQ-006]

# Metrics
duration: 10min
completed: 2026-05-26
---

# Phase 03 Plan A-04: Extend apply_event Dispatcher Summary

**Tool description in VAULT_TOOL_DEFINITIONS extended with 20 Phase 03 event types and concise payload-shape hints; 44 dispatch-layer regression tests added — dispatcher logic unchanged because validateEvent (extended in 03-A-02) absorbs the new union members transparently.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-26T23:28:00+02:00 (approx)
- **Completed:** 2026-05-26T23:37:33+02:00
- **Tasks:** 2 (Task 1: tool-description edit + Task 2: dispatch tests)
- **Files modified:** 2 (`src/ai/master/vault/tools.ts`, `tests/ai/master/vault/tools.test.ts`)

## Accomplishments

- **Tool description carries all 27 event types.** The Phase 02 description listed 7 mutation types + the seed event; the Phase 03 extension lists all 20 new types (`temp_hp_set`, `death_save_*`, `concentration_*`, `exhaustion_*`, `hit_dice_*`, `resource_*`, `inspiration_*`, `attune`/`unattune`, `focus_*`, `xp_award`) with their canonical payload shapes. The model now sees the full contract.
- **44 new dispatch-layer test cases.** Organized into 5 describe blocks: tool-description-surface (4 cases), happy-path-for-each-Phase-03-type (21 cases including the roster sanity check), NIT-1-UUID-guard (6 cases), malformed-payload-rejection (10 cases), multi-event-sequencing (2 cases), view-regen-synchronicity (1 case).
- **Zero regression on Phase 02 baseline.** All 51 Phase 02 dispatch tests pass unchanged; REQ-010 4-tool surface preserved; the `apply_event` dispatch branch in `dispatchVaultTool` is byte-identical to the Phase 02 shipment.
- **Project-wide typecheck clean.** With 03-A-03's projector reducer arms now landed (commit `847467d` from the concurrent Wave 3 agent), `pnpm typecheck` reports zero errors. The pre-existing `projector.ts:281` exhaustiveness gap tracked in `deferred-items.md` is fully resolved.

## Task Commits

Each task was committed atomically (no `--amend`, no force-push):

1. **Task 1: Update apply_event tool description in VAULT_TOOL_DEFINITIONS** — `de6aea3` (feat)
2. **Task 2: Add dispatch-level smoke tests for Phase 03 event types** — `22b09da` (test)

_Note: No TDD gate enforced — this is an additive description + smoke-test plan, not a behavior-adding feature._

## Files Created/Modified

- `src/ai/master/vault/tools.ts` — Extended the `apply_event` entry in `VAULT_TOOL_DEFINITIONS`: the `description` field now enumerates all 27 event types categorically (HP, conditions, slots, inventory, temp HP, death saves, concentration, exhaustion, hit dice, resources, inspiration, attunement, focus, XP); the `type.description` field lists every type by name; the `payload.description` field carries per-type payload shape hints mirroring `validateEvent` 1:1. Module JSDoc updated with a Phase 03 extension note + NIT 8 prompt-size tradeoff rationale. Dispatch logic (`dispatchVaultTool` body) is unchanged.
- `tests/ai/master/vault/tools.test.ts` — Appended one new `describe('dispatchVaultTool — apply_event (Phase 03 event types — plan 03-A-04)')` block with 5 nested describes and 44 test cases (535 LOC). Uses the existing `withStubbedRoot` helper + `CAMPAIGN_UUID` / `CHAR_UUID` constants from the Phase 02 block. Encapsulates `eventCount()` and `parseDispatchOk()` helpers locally.

## Decisions Made

- **Payload-table-in-description vs. payload-table-in-docs (NIT 8):** Kept the explicit per-type payload table inside the tool description (+~1.2KB / turn). The system-prompt-on-every-turn placement matches spike 009's "explicit beats implicit" principle. Future work can extract to `/tools/index.md` if `prompt_eval_count` measurements show a bottleneck — preserved as a JSDoc note for future planners.
- **Tests-stop-at-dispatcher-boundary:** Test assertions cover `result.isError === false`, the `{ok, event_id}` envelope shape, and `events.md` line count. Phase 03 frontmatter field assertions (e.g., `temp_hp: 5`, `death_saves.failures: 2`) are projector.test.ts's job (plan 03-A-03). This decoupling kept my tests deterministic across the Wave 3 parallel-execution timeline regardless of when 03-A-03 landed.
- **Roster matches schema reality, not plan-body shorthand:** Plan body's example tool description mentioned `level_up` in the type list; the actual `VAULT_EVENT_TYPES` union (events-schema.ts) does NOT include it (audit classified as provisional and 03-A-02 did not ship it). Listing `level_up` would cause `validateEvent` to reject any model emission with "unknown event type". My description matches the schema reality: 20 hard types, no `level_up`.
- **Each test seeds via `campaign_initialized` and asserts UUID guard preservation:** The NIT 1 guard requires `payload.character` to be a UUID matching a seeded character. The Phase 03 NIT 1 reminder in the plan-check was that the guard should still fire for every new type — confirmed via 6 representative `it.each` rows in the "NIT 1 UUID guard applies to every Phase 03 type" describe block.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed apostrophe-in-string-literal parse error in test title**
- **Found during:** Task 2 (first test run after appending the new describe block)
- **Issue:** Test title `'rejects typo'd type name'` used an unescaped apostrophe inside a single-quoted string literal, causing a vite/oxc parse error: `Expected ',' or ')' but found 'Identifier' ... d type name'`. The whole test file failed to load (0/95 tests ran). My own typo introduced in Task 2.
- **Fix:** Replaced `typo'd` with `misspelled` in the test title (no apostrophe, semantically equivalent).
- **Files modified:** `tests/ai/master/vault/tools.test.ts`
- **Verification:** `pnpm test tests/ai/master/vault/tools.test.ts -- --run` → 95/95 pass.
- **Committed in:** `22b09da` (part of Task 2 commit)

**2. [Rule 3 - Out-of-scope] Concurrent peer-agent in-flight changes in adjacent files (NOT auto-fixed — left alone per scope boundary)**
- **Found during:** Pre-Task-1 baseline check (`git status` showed `events-schema.ts`, `projector.ts`, `tools.ts` all modified)
- **Issue:** Wave 3 contract specified disjoint files for parallel plans, but the working tree contained uncommitted changes from peer agents (03-A-03 projector extension and other Wave 3 work) in `events-schema.ts` and `projector.ts`. The scope boundary rule prohibits touching files outside my plan.
- **Action:** Did NOT stage, edit, or revert the peer-agent changes. Staged only my own `tools.ts` (Task 1) and `tools.test.ts` (Task 2) via `git add <specific-file>` (not `git add .`). Verified `git diff --cached --stat` after each `git add` to confirm only my scope was staged.
- **Files modified:** None by me in `events-schema.ts` or `projector.ts`. Peer agents committed their work mid-execution (commit `847467d` for projector arms landed before my Task 2 commit).
- **Verification:** `git log` shows my two commits side-by-side with peer commits; `pnpm typecheck` is clean project-wide; `pnpm test` is green.

---

**Total deviations:** 2 (1 auto-fixed bug in my own code, 1 out-of-scope discovery handled per scope boundary)
**Impact on plan:** No scope creep. The plan executed as specified; the only auto-fix was a typo I introduced in my new test title. Concurrent peer work was left untouched per the destructive-git prohibition.

## Issues Encountered

- **Pre-existing `projector.ts:281` exhaustiveness typecheck error (resolved mid-execution).** When I started, `pnpm typecheck` reported 1 error in `projector.ts` (the `_exhaustive: never` arm not seeing the 20 new union members, tracked in `deferred-items.md` as the "Wave 2 in-flight exhaustiveness gap"). During my execution the 03-A-03 peer agent committed `847467d feat(phase-03): add applyEvent reducer arms for 20 Phase 03 event types`, which closed the gap. By the end of Task 2, `pnpm typecheck` was clean project-wide. No action needed from me.

## User Setup Required

None — no external service configuration introduced by this plan.

## Next Phase Readiness

**Ready for plan 03-A-09 (DualWriter).** The dual-write parity check (`parity-check.ts` shipped in 03-A-08) can now exercise the full Phase 03 event surface end-to-end: the LLM sees the new types in the tool description, emits them, `validateEvent` accepts them, the projector reduces them (03-A-03 reducer arms), the events.md log captures them, and parity-check can compare the resulting state against Postgres.

**Phase 03 Wave 3 status (cross-check with peer SUMMARYs):**

- ✅ 03-A-02 — events-schema extension (committed `8506977`)
- ✅ 03-A-03 — projector reducer arms (committed `847467d` mid-execution of this plan)
- ✅ 03-A-04 — this plan (commits `de6aea3` + `22b09da`)
- ✅ 03-A-07 — migrate-campaigns-to-vault script (committed `efeb880`)

The Wave 3 fan-in checkpoint is now satisfied for the 4-plan parallel cohort.

## Threat Flags

None — this plan modified existing tool surface and tests only. No new network endpoints, auth paths, file access patterns, or trust boundaries introduced.

## Self-Check: PASSED

- File `src/ai/master/vault/tools.ts` modified — FOUND (description and JSDoc carry Phase 03 content; `grep -c "name: 'apply_event'"` returns 1; `grep -oE "temp_hp_set|death_save_success|..." | sort -u | wc -l` returns 20)
- File `tests/ai/master/vault/tools.test.ts` modified — FOUND (95 tests, 44 of them new under the Phase 03 describe block)
- File `.planning/phases/03-migration-cutover/03-A-04-SUMMARY.md` created — FOUND (this file)
- Commit `de6aea3` exists — FOUND (`feat(vault): extend apply_event tool description with Phase 03 event types (03-A-04)`)
- Commit `22b09da` exists — FOUND (`test(vault): dispatch-layer smoke tests for Phase 03 event types (03-A-04)`)
- All 95 tools.test.ts tests pass — VERIFIED (278ms duration)
- `pnpm typecheck` reports 0 errors project-wide — VERIFIED
- REQ-010 (4-tool surface) preserved — VERIFIED (grep returns 4)
- Phase 02 dispatch tests unchanged — VERIFIED (51 baseline tests still pass)

---
*Phase: 03-migration-cutover*
*Completed: 2026-05-26*
