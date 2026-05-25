---
phase: 02
plan: 06
type: execute
wave: 1
depends_on: []
files_modified:
  - src/sessions/types.ts
  - src/ai/master/vault/loop.ts
  - tests/sessions/turn-tool-call-cap.test.ts
autonomous: true
requirements: [REQ-010]
must_haves:
  truths:
    - "src/sessions/types.ts exports a new constant VAULT_TURN_TOOL_CALL_CAP = 20 (distinct from TURN_TOOL_CALL_CAP = 12)"
    - "The vault loop (runVaultToolLoop) reads VAULT_TURN_TOOL_CALL_CAP as its default cap when toolCallCap is not explicitly passed"
    - "The baked loop (runToolLoop) continues to use TURN_TOOL_CALL_CAP = 12 unchanged"
    - "A vault turn that emits 18 apply_event calls + 1 read_vault_multi + 1 end_turn (=20 total) does NOT trigger truncated:true"
    - "A vault turn that emits 21 tool calls does trigger truncated:true"
  artifacts:
    - path: "src/sessions/types.ts"
      provides: "VAULT_TURN_TOOL_CALL_CAP constant"
      contains: "VAULT_TURN_TOOL_CALL_CAP"
    - path: "src/ai/master/vault/loop.ts"
      provides: "Updated default cap reference"
      contains: "VAULT_TURN_TOOL_CALL_CAP"
    - path: "tests/sessions/turn-tool-call-cap.test.ts"
      provides: "Regression test for cap value + vault/baked separation"
  key_links:
    - from: "src/ai/master/vault/loop.ts"
      to: "src/sessions/types.ts"
      via: "imports VAULT_TURN_TOOL_CALL_CAP (in addition to TURN_TIMEOUT_MS)"
      pattern: "VAULT_TURN_TOOL_CALL_CAP"
---

# Plan 02-06: Tool Loop Cap Bump for Vault-Mutation Turns

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 1 (no dependencies — small surgical change)
**Status:** Pending
**Estimated diff size:** ~40 LOC source + ~50 LOC tests / 3 files

## Goal

Introduce a new constant `VAULT_TURN_TOOL_CALL_CAP = 20` in `src/sessions/types.ts`, alongside the existing `TURN_TOOL_CALL_CAP = 12` (which the baked loop continues to use). Update `src/ai/master/vault/loop.ts` to read the new constant as its default cap. The baked path is untouched.

Phase 01's vault path inherited the existing `TURN_TOOL_CALL_CAP = 12` because read-only turns rarely emit more than 6 tool calls (spike 011 measurement). Phase 02 adds the `apply_event` tool — combat turns will fire many mutations (per Pitfall 4 from RESEARCH.md): 5 HP changes + 3 condition adds + 2 spell slot uses + 2 reads + 1 end_turn = ~13 calls easily, and complex multi-character turns reach 20. The baked loop never emits `apply_event` (no such tool), so the cap separation is correct and minimal.

The two caps are exported side-by-side from `src/sessions/types.ts`. The baked tool loop (`src/ai/master/tool-loop.ts` — unchanged) keeps reading `TURN_TOOL_CALL_CAP`. The vault loop (`src/ai/master/vault/loop.ts`) reads the new `VAULT_TURN_TOOL_CALL_CAP`. The vault loop's `toolCallCap` override parameter remains, so tests can still pass a custom value.

## Requirements satisfied

- **REQ-010** 4-tool surface — this plan is the load-bearing change that lets the 4th tool (`apply_event`) actually be useful: without the cap bump, a turn with many mutations would truncate before finishing combat resolution.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/sessions/types.ts` | EDIT (add ~6 LOC) | Add `VAULT_TURN_TOOL_CALL_CAP = 20` constant + JSDoc. |
| `src/ai/master/vault/loop.ts` | EDIT (~2 LOC change) | Update default to `VAULT_TURN_TOOL_CALL_CAP`. |
| `tests/sessions/turn-tool-call-cap.test.ts` | NEW | Regression test: assert both constants exist with correct values; assert vault loop uses the new cap. |

## Tasks

<task type="auto">
  <name>Task 1: Add VAULT_TURN_TOOL_CALL_CAP constant to sessions/types.ts</name>
  <files>src/sessions/types.ts</files>
  <read_first>
    - src/sessions/types.ts (line 39 — existing TURN_TOOL_CALL_CAP = 12; lines 35-50 — context for the constant declaration; line 45 — envPositiveInt for the TURN_TIMEOUT_MS pattern as a style reference)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Pitfall 4 — explicit recommendation to raise to ~20 for vault turns; Decision 11 — VAULT_TURN_TOOL_CALL_CAP = 20)
  </read_first>
  <action>
Edit `src/sessions/types.ts` (preserve everything else verbatim).

Locate the existing line `export const TURN_TOOL_CALL_CAP = 12;` (currently line 39). Immediately AFTER this line, insert:

```ts
/**
 * Tool-call cap for Phase 02 vault-mutation turns (`runVaultToolLoop`).
 *
 * Higher than the baked-path cap (12) because combat turns on the vault
 * path fire one `apply_event` per HP change / condition add / spell slot
 * use. A representative combat turn: 5 HP changes + 3 condition adds +
 * 2 spell slot uses + 2 read_vault_multi + 1 end_turn = 13 calls, leaving
 * headroom for multi-character turns that easily reach 18-20.
 *
 * The baked loop (no apply_event tool) continues to use the smaller cap.
 *
 * Phase 02 — locked by Decision 11 (Pitfall 4 from RESEARCH.md). Re-tune
 * after observing real combat sessions if needed.
 */
export const VAULT_TURN_TOOL_CALL_CAP = 20;
```

Do NOT remove or modify `TURN_TOOL_CALL_CAP`. The baked loop continues to read it unchanged.
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "VAULT_TURN_TOOL_CALL_CAP\\|TURN_TOOL_CALL_CAP" src/sessions/types.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "export const TURN_TOOL_CALL_CAP = 12" src/sessions/types.ts` returns exactly 1 (baked cap preserved)
    - `grep -c "export const VAULT_TURN_TOOL_CALL_CAP = 20" src/sessions/types.ts` returns exactly 1 (new cap added)
    - `pnpm typecheck` exits 0
    - The two constants are declared adjacently in the file (JSDoc continuity)
  </acceptance_criteria>
  <done>
    Constant exported. Tasks 2 + 3 consume it.
  </done>
</task>

<task type="auto">
  <name>Task 2: Update vault loop default cap reference</name>
  <files>src/ai/master/vault/loop.ts</files>
  <read_first>
    - src/ai/master/vault/loop.ts (line 7 — existing import statement to update; line 78 — toolCallCap default to VAULT_TURN_TOOL_CALL_CAP)
    - src/sessions/types.ts (updated from Task 1)
  </read_first>
  <action>
Edit `src/ai/master/vault/loop.ts` (preserve everything else verbatim — minimal surgical change).

**Change 1** — Update the import on line 7. Current:
```ts
import {
  TURN_TOOL_CALL_CAP,
  TURN_TIMEOUT_MS,
  type TurnEvent,
} from '@/sessions/types';
```
Replace `TURN_TOOL_CALL_CAP` with `VAULT_TURN_TOOL_CALL_CAP`:
```ts
import {
  VAULT_TURN_TOOL_CALL_CAP,
  TURN_TIMEOUT_MS,
  type TurnEvent,
} from '@/sessions/types';
```

**Change 2** — Update the default-cap fallback on line 78. Current:
```ts
const toolCallCap = input.toolCallCap ?? TURN_TOOL_CALL_CAP;
```
Replace with:
```ts
const toolCallCap = input.toolCallCap ?? VAULT_TURN_TOOL_CALL_CAP;
```

Do NOT change any other line. The `input.toolCallCap` override parameter remains so tests can still pass custom values.

Add or extend the existing module-level JSDoc to note: "Default tool-call cap is `VAULT_TURN_TOOL_CALL_CAP = 20` (higher than the baked loop's `TURN_TOOL_CALL_CAP = 12`) to accommodate combat turns with many `apply_event` calls — see RESEARCH Pitfall 4."
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/loop.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "VAULT_TURN_TOOL_CALL_CAP" src/ai/master/vault/loop.ts` returns ≥ 2 (import + default reference)
    - `grep -c "TURN_TOOL_CALL_CAP" src/ai/master/vault/loop.ts | grep -v VAULT` should match only the import-pre-prefix `VAULT_TURN_TOOL_CALL_CAP` — there should be ZERO standalone references to the smaller cap in the vault loop file. Run `grep -E "(^|[^_])TURN_TOOL_CALL_CAP" src/ai/master/vault/loop.ts | wc -l` — expected output: 0
    - `pnpm typecheck` exits 0
    - Phase 01's `tests/ai/master/vault/loop.test.ts` continues to pass (Phase 01 tests pass `toolCallCap: 3` explicitly — no behavioral change)
  </acceptance_criteria>
  <done>
    Vault loop now reads the new constant by default. Plan 02-07 (apply_event dispatch) inherits this — combat turns up to 20 calls won't truncate.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/sessions/turn-tool-call-cap.test.ts</name>
  <files>tests/sessions/turn-tool-call-cap.test.ts</files>
  <read_first>
    - src/sessions/types.ts (updated from Task 1 — both constants)
    - tests/ai/master/vault/loop.test.ts (style reference — vault loop test patterns, MasterProvider mock)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Pitfall 4 — operational rationale; the test documents the regression it prevents)
  </read_first>
  <action>
Create `tests/sessions/turn-tool-call-cap.test.ts`. Tests live under `tests/sessions/` because the cap constants are owned by `src/sessions/types.ts` (Phase 01 convention).

Test structure — one top-level `describe('turn-tool-call cap separation')` with these nested describes:

1. **`describe('constants')`:**
   - `it('TURN_TOOL_CALL_CAP is 12 (baked path unchanged)')` → `expect(TURN_TOOL_CALL_CAP).toBe(12)`
   - `it('VAULT_TURN_TOOL_CALL_CAP is 20 (raised for combat turns)')` → `expect(VAULT_TURN_TOOL_CALL_CAP).toBe(20)`
   - `it('the two constants are distinct')` → `expect(TURN_TOOL_CALL_CAP).not.toBe(VAULT_TURN_TOOL_CALL_CAP)`

2. **`describe('runVaultToolLoop honors VAULT_TURN_TOOL_CALL_CAP as default')`:**
   - Mock a `MasterProvider` that returns `tool_use` blocks forever (until told to stop) — pattern from `tests/ai/master/vault/loop.test.ts`.
   - `it('does not truncate at 20 tool calls')` → mock provider returns 20 read_vault_multi calls in a row (one per iteration), then a final iteration with no tool_use. Call `runVaultToolLoop({...})` WITHOUT passing `toolCallCap`. Expected: `result.toolCallCount === 20`, `result.truncated === false`.
   - `it('truncates at 21 tool calls')` → mock provider returns 21 read_vault_multi calls. Expected: `result.truncated === true`, `result.toolCallCount === 20` (the 21st was rejected by the cap check).
   - `it('toolCallCap override still works')` → pass `toolCallCap: 5` explicitly, mock 6 tool_use calls. Expected: `result.truncated === true` (the override takes precedence over the constant).

3. **`describe('runToolLoop still uses TURN_TOOL_CALL_CAP = 12')`:**
   - This is the baked path — the existing `src/ai/master/tool-loop.ts` (not modified by this plan). The test asserts that the baked loop's behavior is preserved by reading its source and checking that it imports `TURN_TOOL_CALL_CAP` (NOT `VAULT_TURN_TOOL_CALL_CAP`). Use a `readFileSync` + regex check:
     ```ts
     const tlSource = readFileSync('src/ai/master/tool-loop.ts', 'utf8');
     expect(tlSource).toMatch(/TURN_TOOL_CALL_CAP/);
     expect(tlSource).not.toMatch(/VAULT_TURN_TOOL_CALL_CAP/);
     ```
   - This is a STATIC ASSERTION (no runtime execution of the baked loop required) — proves no accidental cross-contamination of the cap constants.

Total: 3 describe blocks, ~7 `it` cases.
  </action>
  <verify>
    <automated>pnpm test tests/sessions/turn-tool-call-cap.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~7 cases pass
    - The "does not truncate at 20 tool calls" test exists and passes
    - The "truncates at 21 tool calls" test exists and passes
    - The static assertion (baked loop does NOT import VAULT_TURN_TOOL_CALL_CAP) exists and passes
    - `pnpm test` (full suite) still green
  </acceptance_criteria>
  <done>
    Regression test in place. Plan 02-07's apply_event tool now has the headroom it needs.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/sessions/turn-tool-call-cap.test.ts` → all cases pass
- Command: `pnpm test` (full suite) → still green (no regression in Phase 01 baked tests)
- Command: `pnpm typecheck` → clean
- Grep gate: `grep -rE "TURN_TOOL_CALL_CAP" src/ai/master/vault/ | grep -vE "VAULT_TURN_TOOL_CALL_CAP" | wc -l` returns 0 (no orphan references to the smaller cap in vault code)

## Open questions

None — the cap value 20 is locked by Decision 11. Future re-tuning after observing real combat sessions is tracked in plan 02-11's SUMMARY follow-ups, not in this plan.

---

# Execution SUMMARY (2026-05-25)

**Status:** COMPLETE
**Executor:** Claude Opus 4.7 (1M context) — gsd-executor wave-1
**Commits:** 3 (one per task)

## Task-by-task

| # | Task | Commit | Result |
|---|------|--------|--------|
| 1 | Add `VAULT_TURN_TOOL_CALL_CAP=20` to `src/sessions/types.ts` | `efbf2f6` | Green. Constant exported with JSDoc; `TURN_TOOL_CALL_CAP=12` preserved verbatim. |
| 2 | Switch `runVaultToolLoop` default to `VAULT_TURN_TOOL_CALL_CAP` | `a24d2d0` | Green. Import + default fallback updated; module JSDoc and field JSDoc reference the new cap. |
| 3 | Write `tests/sessions/turn-tool-call-cap.test.ts` | `4eaf09a` | Green — all 7 cases pass on first run. |

## Acceptance criteria — final status

| Criterion | Status |
|---|---|
| `src/sessions/types.ts` exports `VAULT_TURN_TOOL_CALL_CAP = 20` distinct from `TURN_TOOL_CALL_CAP = 12` | OK — `grep -c` returns 1 each |
| `runVaultToolLoop` reads `VAULT_TURN_TOOL_CALL_CAP` as default when `toolCallCap` not passed | OK — line 82: `input.toolCallCap ?? VAULT_TURN_TOOL_CALL_CAP` |
| Baked loop (`src/ai/master/tool-loop.ts`) continues using `TURN_TOOL_CALL_CAP = 12` unchanged | OK — static assertion test verifies imports |
| Vault turn with 20 calls does NOT trigger `truncated:true` | OK — `does not truncate at 20 tool calls` test green |
| Vault turn with 21 calls DOES trigger `truncated:true` | OK — `truncates at 21 tool calls` test green |
| `tests/sessions/turn-tool-call-cap.test.ts` — 7 cases pass | OK — 7/7 passed in 10ms |
| `pnpm typecheck` clean | Pre-existing error in `src/lib/preferences.ts:367` (Plan 02-05 Task 1 partial), resolved later in same wave by Plan 02-05 Task 2 — not caused by Plan 02-06 |
| `pnpm test` (full suite) green | 10 pre-existing failures, all out-of-scope (RAG/multiplayer/coalesce/applicator-inventory) — verified pre-Plan-02-06 by file-content analysis (none reference cap constants) |

## Deviations

### Rule 1 — planner assumption inaccurate (acceptance criteria Task 2)

The plan claimed "Phase 01 tests pass `toolCallCap: 3` explicitly — no behavioral change". This is false: `tests/ai/master/vault/loop.test.ts` lines 109-121 — the existing `truncates when tool-call cap would be exceeded` test does NOT pass `toolCallCap` explicitly; it relies on the implicit default. Switching the default from 12 → 20 broke this test (queues 13 responses, but the loop now wants up to 21).

**Fix applied (Task 2 commit `a24d2d0`):** updated the Phase 01 test to queue 21 responses and expect `toolCallCount === 20`, matching the new default. The test's intent ("truncate on overflow") is preserved verbatim; only the magnitudes shift.

### Rule 1 — planner internal contradiction (Task 2 acceptance criteria)

Plan Task 2 simultaneously requires:
- "Add or extend the existing module-level JSDoc to note: '... `TURN_TOOL_CALL_CAP = 12` ...'" (literal text)
- "`grep -E "(^|[^_])TURN_TOOL_CALL_CAP" src/ai/master/vault/loop.ts | wc -l` — expected output: 0"

These are mutually exclusive — the JSDoc requirement introduces exactly one match. **Resolution:** satisfied the JSDoc requirement (operator-facing documentation has higher value than a regex artifact), and confirmed by stripping JSDoc lines that the **code-level** orphan count is 0:
```
grep -vE "^\s*\*" src/ai/master/vault/loop.ts | grep -E "(^|[^_])TURN_TOOL_CALL_CAP" | wc -l
# → 0
```
The intent of the grep gate ("no real consumer of the smaller cap in vault code") is preserved.

### Rule 3 (scope boundary) — pre-existing typecheck error logged

Pre-existing typecheck failure in `src/lib/preferences.ts:367` (missing `vaultMutations` in `Required<CampaignSettings>` default) — introduced by Plan 02-05 Task 1, resolved later in the same wave by Plan 02-05 Task 2. Logged in `.planning/phases/02-vault-write-path-event-sourcing/deferred-items.md` for traceability (entry was further annotated by the parallel Plan 02-05 executor confirming resolution).

### Rule 3 (scope boundary) — pre-existing RAG test failures logged

Pre-existing failures in `tests/ai/master/system-prompt.mode.test.ts` (RAG block injection) — verified reproducible on bare main without Plan 02-06's `tests/sessions/turn-tool-call-cap.test.ts`. Logged in `deferred-items.md`. Not caused by the cap rename.

## Stubs / unwired data sources

None — this plan is pure constant-rename + regression test. No UI or data paths touched.

## Threat flags

None — the cap separation is a pure correctness fix for an existing trust boundary (turn truncation under high tool-call counts). No new network endpoints, file paths, or auth surfaces.

## Self-check

| Claim | Verification |
|---|---|
| `src/sessions/types.ts` has `VAULT_TURN_TOOL_CALL_CAP = 20` | `grep -c "VAULT_TURN_TOOL_CALL_CAP = 20" src/sessions/types.ts` → 1 |
| `src/ai/master/vault/loop.ts` imports `VAULT_TURN_TOOL_CALL_CAP` | `grep -c "VAULT_TURN_TOOL_CALL_CAP" src/ai/master/vault/loop.ts` → 4 (import + default + 2 JSDoc) |
| `tests/sessions/turn-tool-call-cap.test.ts` exists with 7 cases | `wc -l tests/sessions/turn-tool-call-cap.test.ts` → 196 lines |
| Commits `efbf2f6`, `a24d2d0`, `4eaf09a` exist in history | `git log --oneline | grep` confirms all three |

## Self-Check: PASSED
