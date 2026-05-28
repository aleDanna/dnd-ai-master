---
phase: 07-vault-combat-playable-d2
plan: "05"
subsystem: ai
tags: [vault, combat, anti-anchoring, directive, recency-bias, qwen3, turn-route]

# Dependency graph
requires:
  - phase: 07-vault-combat-playable-d2
    provides: "07-01 tools/events-schema, 07-02 combat-lifecycle prompt block, 07-03 turn-order combat handoff"
provides:
  - "buildTurnDirective pure helper: POV + apply_event/combat + roll lines gated by vaultMutations/manualRolls"
  - "appendDirectiveToHistory: immutable recency-append to last user turn"
  - "vault branch route: directive wired before runVaultToolLoop"
affects: [vault-path, turn-route, combat-session-smoke]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Recency-position directive pattern: append mechanic reminders to last user turn, not system prompt, to break model anchoring"
    - "Gate on both flags: null return when no mechanics requested (read-only campaigns unaffected)"
    - "Immutable history mutation: spread + new array; never mutate input objects"

key-files:
  created:
    - src/ai/master/vault/turn-directive.ts
    - tests/ai/master/vault/turn-directive.test.ts
  modified:
    - src/app/api/sessions/[id]/turn/route.ts

key-decisions:
  - "Directive is a SEPARATE module from buildVaultSystemPrompt — REQ-022 byte-stability is completely untouched"
  - "null return when both vaultMutations and manualRolls are falsy — read-only campaigns receive no noise"
  - "appendDirectiveToHistory uses { ...last, content } spread so any extra fields on T are preserved (forward-compat)"
  - "Route cast pattern: vault history is always string-content; cast to narrower type for helper call, cast back for MessageParam[]"
  - "Italian is the primary directive language (wording at discretion per plan spec); language param reserved for future expansion"

patterns-established:
  - "Anti-anchoring via recency position: always append model-behavior reminders at the END of assembled history, never in system prompt"

requirements-completed: [REQ-038]

# Metrics
duration: 10min
completed: 2026-05-29
---

# Phase 7 Plan 05: Per-Turn Anti-Anchoring Directive Summary

**Italian recency-position directive (buildTurnDirective) breaks qwen3/gemma4 narration-anchoring by appending POV + apply_event/combat + roll reminders to the last user turn before runVaultToolLoop**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-29T00:21:00Z
- **Completed:** 2026-05-29T00:24:30Z
- **Tasks:** 1 complete (Task 2 pending operator smoke — see checkpoint below)
- **Files modified:** 3

## Accomplishments
- Pure deterministic helper `buildTurnDirective` with null-gate (no mechanics = null = history unchanged)
- `appendDirectiveToHistory` immutable helper: appends to last user turn or pushes new trailing user turn
- Vault branch wired: directive computed and appended after `vaultHistory` assembly, before `runVaultToolLoop`
- 24 unit tests covering null-gate, POV line always-present, combat events gated on vaultMutations, roll line gated on manualRolls, determinism (100 calls), immutability, empty history, assistant-last-turn
- `pnpm tsc --noEmit` clean; no new test failures (1 pre-existing applicator/gp-stack failure unchanged)

## Task Commits

1. **Task 1: buildTurnDirective + appendDirectiveToHistory + route wiring (TDD)** - `402de30` (feat)

**Plan metadata:** pending (Task 2 checkpoint not yet approved)

## Files Created/Modified
- `/Users/alessiodanna/projects/dnd-ai-master/src/ai/master/vault/turn-directive.ts` — Pure `buildTurnDirective` + `appendDirectiveToHistory` exports; Italian directive lines; no non-deterministic constructs
- `/Users/alessiodanna/projects/dnd-ai-master/tests/ai/master/vault/turn-directive.test.ts` — 24 unit tests covering all acceptance criteria
- `/Users/alessiodanna/projects/dnd-ai-master/src/app/api/sessions/[id]/turn/route.ts` — Import + wiring in vault branch (lines ~39 and ~346-368)

## Decisions Made
- Directive is a separate module from `buildVaultSystemPrompt` so REQ-022 byte-stability is fully untouched
- Null return gating preserves exact byte-identical history for read-only campaigns (no-op path)
- Route uses a cast (`vaultHistory as { role: string; content: string }[]`) because Anthropic's `MessageParam` has `content: string | ContentBlockParam[]` but vault history always has string content; the cast is safe and documented inline
- Italian directive wording chosen (primary play language per spec); `language` param reserved for future multi-language expansion

## Deviations from Plan

**1. [Rule 1 - Bug] TypeScript type incompatibility between MessageParam and narrow helper constraint**
- **Found during:** Task 1 (wiring into route.ts)
- **Issue:** `appendDirectiveToHistory<T extends { role: string; content: string }>` incompatible with `Anthropic.Messages.MessageParam[]` (`content: string | ContentBlockParam[]`; `role: 'user' | 'assistant'`)
- **Fix:** Added explicit cast at call site in route.ts with inline comment explaining why it is safe; fixed test's empty-array call to supply explicit type parameter `<Msg>`
- **Files modified:** `src/app/api/sessions/[id]/turn/route.ts`, `tests/ai/master/vault/turn-directive.test.ts`
- **Verification:** `pnpm tsc --noEmit` exits 0
- **Committed in:** `402de30`

---

**Total deviations:** 1 auto-fixed (Rule 1 — TypeScript type incompatibility)
**Impact on plan:** Minimal; the cast is correct and safe. No behavior change.

## Issues Encountered
None beyond the TypeScript type deviation above.

## Checkpoint: Task 2 Pending Operator Smoke

Task 2 is a `checkpoint:human-verify`. Execution stopped here per plan spec.

**Verification steps for operator:**
1. Restart `pnpm dev` (load the new code) + Ollama (qwen3:30b) up; open One Piece campaign.
2. Start a fight: "attacco Veyra con un pugno deciso per iniziare lo scontro".
3. Verify:
   - (a) Master opens combat: monster spawned, initiative set, CombatTracker shows encounter (round, order, monster HP)
   - (b) You get dice-roll buttons for attack/damage
   - (c) Turns alternate: you act on your turn; master runs monster's turn and HP changes land
   - (d) `combat_end` clears the tracker
4. POV check: master stays in 2nd person ("Ti lanci...").

**Resume signal:** Reply "approved" if combat starts + renders + rolls appear, or describe what still fails.

## Next Phase Readiness
- Once operator smoke passes (Task 2 checkpoint), plan 07-05 is complete
- D2 combat is playable end-to-end on real narration-heavy campaigns (One Piece)
- No blockers for subsequent plans

---
*Phase: 07-vault-combat-playable-d2*
*Completed: 2026-05-29 (Task 1; Task 2 pending smoke)*
