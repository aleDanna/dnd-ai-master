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
