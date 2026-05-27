---
phase: 03-migration-cutover
plan: B-05
subsystem: ai
tags: [vault, summarizer, condense, summarization, req-023, session-state, tool-loop]

# Dependency graph
requires:
  - phase: 03-B-04
    provides: "maybeCondense() — standalone Phase 03-B summarizer with kill-switch + persistence"
  - phase: 03-B-03
    provides: "session_state.summaryBlock JSONB column"
  - phase: 03-A-10
    provides: "sessionId threading into runVaultToolLoop input"
provides:
  - "runVaultToolLoop now invokes maybeCondense before each provider.completeMessage round-trip"
  - "Persisted summaryBlock auto-restored on loop entry as `[Riassunto dei turni precedenti]` user message (Pitfall 4)"
  - "New TurnEvent variant `summarized` carrying tokensBefore/tokensAfter for SSE observability"
affects: [03-B-07, 03-D-01]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-iteration condensation in tool-loop: `maybeCondense` runs BEFORE every `provider.completeMessage`, reassigning the working `messages` array when condensed:true"
    - "Restart-safe summary restore: `session_state.summaryBlock` is read on loop entry and injected as a user-role `[Riassunto ...]` message right after the anchor, avoiding re-summarization on cold start"
    - "Vitest hoisted mocks: `vi.hoisted` block exposes `dbSelectMock`/`dbUpdateMock` to the `vi.mock` factory so per-test scenarios can control DB read results"

key-files:
  created: []
  modified:
    - "src/ai/master/vault/loop.ts (66 LOC added: imports, restore block, condense call site, summarized event emit)"
    - "src/sessions/types.ts (4 LOC added: new `summarized` variant in TurnEvent union)"
    - "tests/ai/master/vault/loop.test.ts (308 LOC added: 8 new it() blocks + inspectableProvider helper + hoisted db mock)"

key-decisions:
  - "Summarizer gated on BOTH sessionId AND model (not just sessionId): without model, REQ-034 forbids picking one ourselves; without sessionId, persistence has no key. Both are silent skips."
  - "TurnEvent.summarized uses FLAT fields (tokensBefore/tokensAfter), not a nested `data` object — matches the existing event-union convention. Plan suggested `data:{...}` shape; rejected for consistency."
  - "Restore-on-entry uses `messages[0]` as the anchor — the Anthropic shape has no role:'system' slot inside messages (systemBlocks are separate), so messages[0] is the campaign opening user turn. Restored summary goes RIGHT AFTER that anchor as a user-role pseudo-message."
  - "DB read failures during restore are NON-FATAL: console.warn + proceed with unaugmented history. The next maybeCondense call will rebuild the summary if still needed. Test 8 enforces this contract."
  - "Tests mock `@/db/client` via vi.mock+vi.hoisted (NOT the real Postgres) — keeps the suite hermetic and lets per-test scenarios control DB select/update behavior without needing DATABASE_URL."

patterns-established:
  - "Phase 03-B summarizer wiring pattern: `let messages = [...history]` (reassignable), restore-on-entry guarded by `sessionId`, condense-before-call guarded by `sessionId && model`, event emit only when `condense.condensed`"
  - "TurnEvent extension pattern: append to the discriminated union with a flat-field variant; consumers using if/else over `event.type` remain compatible (no exhaustive switches in current consumers)"

requirements-completed: [REQ-023]

# Metrics
duration: 22min
completed: 2026-05-27
---

# Phase 03 Plan B-05: Wire maybeCondense Into runVaultToolLoop Summary

**`runVaultToolLoop` now condenses prior turns at the 15K-token boundary via `maybeCondense` before each provider round-trip and restores persisted summaries on session resume, closing REQ-023 end-to-end.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-05-27T08:33:46Z
- **Completed:** 2026-05-27T08:55:19Z
- **Tasks:** 2/2
- **Files modified:** 3

## Accomplishments

- `runVaultToolLoop` invokes `maybeCondense(messages, provider, model, sessionId)` before EVERY `provider.completeMessage` call. When the working history exceeds `MASTER_SUMMARIZE_TRIGGER` (default 15K tokens), the loop replaces its `messages` array with `[anchor, summary, ...recent]` and emits a `summarized` event with the tokensBefore/tokensAfter pair.
- On loop entry, `session_state.summaryBlock` is read once and (if present) injected as a `[Riassunto dei turni precedenti]\n{text}` user message right after `messages[0]`. This closes Pitfall 4: a Next.js restart no longer triggers redundant re-summarization on the next turn of an already-condensed session.
- `TurnEvent` union extended with `{ type: 'summarized'; tokensBefore: number; tokensAfter: number }` — SSE subscribers (`notifySession`, `narrative-pane`) can now log/track compression ratios without re-tokenizing.
- 8 new test cases prove the wiring end-to-end: no-op below threshold, fires above threshold, restores existing summaryBlock (Pitfall 4), kill-switch off, sessionId undefined skip, model undefined skip, multi-turn re-fire, DB-read failure non-fatal.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire maybeCondense + summaryBlock restore into runVaultToolLoop** — `9955867` (feat)
2. **Task 2: Extend tests/ai/master/vault/loop.test.ts with summarizer cases** — `2a94c7a` (test)

## Files Created/Modified

- `src/ai/master/vault/loop.ts` — Added `drizzle-orm`/`@/db/client`/`@/db/schema`/`./condense` imports; switched `messages` from `const` to `let`; added 26-LOC restore block guarded by `sessionId` with non-fatal error handling; added 11-LOC condense-call block at the top of the iteration loop guarded by `sessionId && model`.
- `src/sessions/types.ts` — Appended `summarized` variant to the `TurnEvent` union with flat `tokensBefore`/`tokensAfter` fields (matches existing event shape).
- `tests/ai/master/vault/loop.test.ts` — Added hoisted `dbSelectMock`/`dbUpdateMock` + `vi.mock('@/db/client', ...)` factory at the top; added `inspectableProvider` helper (variant of `scriptedProvider` with `vi.fn` for argument introspection); added `largeHistoryAboveDefaultThreshold` / `smallHistory` fixtures; added `describe('runVaultToolLoop — REQ-023 per-turn summarization')` with 8 it() blocks.

## Decisions Made

1. **Gating condition on BOTH `sessionId` AND `model`** — The plan pseudo-code shows `if (sessionId) { ... maybeCondense(..., model, sessionId) ... }`. But `maybeCondense` requires a non-empty `model` string (REQ-034 forbids per-turn router selection). When the caller omits `model`, we silently skip the summarizer rather than passing an empty string. Test "model undefined: skips maybeCondense" enforces this.

2. **TurnEvent shape — flat fields not nested `data`** — Plan's pseudo-code suggested `onEvent({type:'summarized', data:{tokensBefore, tokensAfter}})`. The existing TurnEvent union uses flat fields throughout (`narrative_delta` has `text`, `tool_use_end` has `ok`/`error`/`rolls`/`mutationCount`, etc.). I emit `{type:'summarized', tokensBefore, tokensAfter}` for consistency. The plan's `data` wrapper would have been a one-off and broken the existing `if (e.type === 'X') { e.field }` consumer idiom.

3. **Restore-on-entry uses `messages[0]` as the anchor (not a system message)** — The Anthropic Message shape has no `role:'system'` slot inside `messages`. SystemBlocks are passed separately via `systemBlocks`. So `history[0]` is the first user/assistant message, NOT a system message. The restored summary is inserted at index 1, right after this opening user turn. This matches the shape `maybeCondense` itself produces in `src/ai/master/vault/condense.ts:220-224`.

4. **DB read failures during restore are non-fatal** — Wrapped the `db.select` in `try/catch` with `console.warn`. A DB outage on the read path shouldn't kill the turn. The summarizer call later in the iteration will re-create the summary if the threshold is still crossed. Test 8 ("DB read failure during restore is non-fatal") enforces this contract — the test injects a thrown error via `dbSelectMock.mockImplementationOnce(() => { throw ... })` and asserts the loop completes successfully with the original (unaugmented) messages.

5. **Test infrastructure: `vi.hoisted` for db mock variables** — The plan didn't prescribe a mocking strategy. I chose `vi.hoisted` to expose `dbSelectMock`/`dbUpdateMock` to the hoisted `vi.mock` factory — a known vitest pattern (also used by `tests/ai/master/vault/condense.test.ts`). Without `vi.hoisted`, the factory references would error with "Cannot access X before initialization" because const declarations are NOT hoisted with the mock.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added model existence guard to summarizer call**
- **Found during:** Task 1 (writing the maybeCondense call block)
- **Issue:** The plan's pseudo-code shows `if (sessionId) { ... maybeCondense(messages, provider, model, sessionId) ... }`. But `model` is typed `string | undefined` in `VaultLoopInput`, and `maybeCondense` requires a non-empty string (REQ-034). Calling with an empty model would either: (a) pass an empty string into the provider's `completeMessage` causing an Ollama 400 error, or (b) silently route to a default model on the provider side — violating REQ-034.
- **Fix:** Tightened the guard to `if (sessionId && model) { ... }`. The summarizer silently skips when no model is configured. Documented in the comment block above the if-statement.
- **Files modified:** `src/ai/master/vault/loop.ts`
- **Verification:** Test "model undefined: skips maybeCondense (REQ-034 — cannot pick a backing model)" added in Task 2; asserts the restore-read still fires (gated only on sessionId) while the condense call is skipped.
- **Committed in:** `9955867` (Task 1 commit)

**2. [Rule 3 - Blocking] Used flat TurnEvent shape instead of plan's nested `data` field**
- **Found during:** Task 1 (writing the emit call)
- **Issue:** The plan's pseudo-code emits `onEvent({ type: 'summarized', data: { tokensBefore, tokensAfter } })`. The existing `TurnEvent` discriminated union in `src/sessions/types.ts` uses flat fields throughout — adding a `data:{...}` variant would have been inconsistent with the rest of the union and broken type-narrowing patterns used by consumers (`narrative-pane.tsx`, `use-turn-stream.ts`).
- **Fix:** Defined the variant as `{ type: 'summarized'; tokensBefore: number; tokensAfter: number }` (flat fields). Updated the emit call to match.
- **Files modified:** `src/sessions/types.ts`, `src/ai/master/vault/loop.ts`
- **Verification:** Test "fires above threshold: emits summarized event with tokensBefore/tokensAfter and persists" reads the flat fields directly.
- **Committed in:** `9955867` (Task 1 commit)

**3. [Rule 2 - Missing Critical] Added non-fatal try/catch around the restore-read DB call**
- **Found during:** Task 1 (writing the restore block)
- **Issue:** The plan's pseudo-code shows a bare `await db.select(...)` with a console.warn in a `catch (e)`. That part WAS in the plan — but the plan didn't make it explicit that the loop must continue with the unaugmented history on failure. Without the try/catch, a transient DB hiccup would abort the entire turn.
- **Fix:** Confirmed the try/catch wraps the select and ALSO confirmed `messages` is not modified when the catch fires (the assignment is INSIDE the `try` block, after `stateRow?.summaryBlock?.text` is verified). Documented the non-fatal contract in the comment block.
- **Files modified:** `src/ai/master/vault/loop.ts` (comment block clarifies the contract)
- **Verification:** Test "DB read failure during restore is non-fatal: loop proceeds with unaugmented history" — `dbSelectMock.mockImplementationOnce(() => { throw new Error('connection refused') })` — confirms the loop completes successfully and the provider's first call sees the ORIGINAL messages array.
- **Committed in:** `2a94c7a` (Task 2 commit, since the verification test lives there)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 missing-critical)
**Impact on plan:** All three are correctness/type-safety adjustments to the plan's pseudo-code. The plan's intent is preserved fully; the changes only tighten the guards and harmonize the TurnEvent shape with existing union conventions. No scope creep.

## Issues Encountered

- **Sibling plan running in parallel on the same working tree.** Plan 03-B-07 (snapshot-pivot) was concurrently modifying `src/sessions/client-snapshot.ts` + creating `src/sessions/use-turn-stream.ts`. Mid-task, the sibling landed two commits (`8d9ede0`, `58ef682`) which briefly perturbed the `git stash` flow during regression checks. Resolved by carefully limiting `git add` to my owned files only (`loop.ts`, `types.ts`, `loop.test.ts`); the untracked `use-turn-stream.ts` remains untouched by me.
- **Pre-existing typecheck flicker.** A spurious typecheck error in `client-snapshot.ts` appeared mid-session (caused by the sibling's in-flight work). It resolved automatically once the sibling's commit landed. Recorded as observation, no action required.
- **Pre-existing `applicator.test.ts` failure** (1/98 — "add_inventory + remove_inventory + set_equipped persist to characters.inventory") confirmed pre-existing via `git stash` round-trip. Already documented in `.planning/phases/03-migration-cutover/deferred-items.md` line 121 by plan 03-A-10. Out of scope for this plan.

## User Setup Required

None — REQ-023 has env-driven knobs (`MASTER_SUMMARIZATION`, `MASTER_SUMMARIZE_TRIGGER`, `MASTER_SUMMARIZE_KEEP_TURNS`) that ship with sensible defaults. Production toggling works without restart (env is read on every `maybeCondense` invocation).

## Next Phase Readiness

- **Wave 5b complete** for the 03-B-05 leg. Sibling 03-B-07 (client-snapshot pivot) ran concurrently on `src/sessions/client-snapshot.ts` and landed cleanly at `58ef682`.
- **REQ-023 closed end-to-end.** The summarizer fires at the configured trigger, persists to `session_state.summaryBlock`, and restores on session resume. The 20-turn long-session bench (plan 03-D-01) will validate the prompt-flat invariant on M4 hardware — that is the next verification gate.
- **No new infrastructure introduced.** Existing `MasterProvider` interface + drizzle + the dispatcher's `sessionId` plumbing carried the integration. No new env vars, no new dependencies.

## Self-Check: PASSED

**Files verified:**
- `src/ai/master/vault/loop.ts` — FOUND (modified)
- `src/sessions/types.ts` — FOUND (modified)
- `tests/ai/master/vault/loop.test.ts` — FOUND (modified)
- `.planning/phases/03-migration-cutover/03-B-05-SUMMARY.md` — FOUND (this file)

**Commits verified:**
- `9955867` — FOUND (feat: wire maybeCondense into runVaultToolLoop)
- `2a94c7a` — FOUND (test: cover REQ-023 summarizer trigger + restart-restore)

**Acceptance criteria verified (from plan):**
- Task 1:
  - `pnpm typecheck` exits 0 — PASSED
  - `grep -c "maybeCondense" src/ai/master/vault/loop.ts` returns >= 2 — PASSED (returns 6)
  - `grep -c "summaryBlock" src/ai/master/vault/loop.ts` returns >= 1 — PASSED (returns 6)
  - Phase 01 + Phase 02 loop tests still pass — PASSED (15/15 existing tests)
  - `messages` is `let` (reassignable) — PASSED (line 144)
  - When sessionId is undefined, the summarizer is skipped — PASSED (tested)
- Task 2:
  - All Phase 01 + Phase 02 cases still pass — PASSED (15/15)
  - All new Phase 03 cases pass — PASSED (8/8, exceeding the planned 6+)
  - Restart-restore case proves Pitfall 4 closed — PASSED (test "restores existing summaryBlock on entry")
  - Test runtime < 15s — PASSED (~440ms total)

---
*Phase: 03-migration-cutover*
*Completed: 2026-05-27*
