---
phase: 05-vault-ability-checks-manual-rolls
plan: 01
subsystem: ai
tags: [vault, prompt-builder, manual-rolls, ability-checks, req-036, req-022, tdd]

# Dependency graph
requires:
  - phase: 02-vault-mutations (prompt-builder vaultMutations gate)
    provides: buildVaultSystemPrompt lines array + applyEventMention conditional-block pattern
  - phase: 04-vault-anti-railroading-prompt
    provides: prior conditional/static block precedent + locked-snapshot test pattern
provides:
  - manualRolls-gated `## Rolls` block in buildVaultSystemPrompt (language- and DC-aware)
  - VaultPromptInput extended with manualRolls? + showDifficultyNumbers?
  - Vault-path DM now instructed to call for ability checks / saving throws / attack+damage rolls via the existing client roll-button surface
  - turn-route vault branch forwards manualRolls + showDifficultyNumbers from userPrefs
affects: [vault-turn-rolls, future-dice-system, future-combat-state-machine]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional prompt block gated on manualRolls ALONE (independent of vaultMutations) — mirrors applyEventMention gating"
    - "Content adapted from baked buildManualRollsRule but self-contained in the vault builder (no baked-tool mention) — keeps vault/baked builders parallel"
    - "Language (it/default-en) + hideDC variants produce different bytes per input, but each input combination is byte-stable (REQ-022)"
    - "Read-only default (manualRolls undefined) byte-identical → existing locked hash UNCHANGED, proving the block is additive/gated"

key-files:
  created:
    - .planning/phases/05-vault-ability-checks-manual-rolls/05-01-SUMMARY.md
  modified:
    - src/ai/master/vault/prompt-builder.ts
    - tests/ai/master/vault/prompt-builder.test.ts
    - src/app/api/sessions/[id]/turn/route.ts

key-decisions:
  - "Block gated on manualRolls === true only (independent of vaultMutations) — a vault campaign with manualRolls=false keeps today's no-rolls behavior (documented limitation, not a regression)"
  - "Bare-d20 for ability checks / saving throws (master adds the sheet modifier at resolution); embedded bonus for attacks/damage — mirrors the baked manual-roll model"
  - "Reused the proven buildManualRollsRule phrasings (parser-compatible IT/EN) verbatim from 05-CONTEXT.md §Exact block content; dropped the baked-only 'do not call rolling tools' sentence (vault has none)"
  - "ZERO changes to roll-parser.ts, client roll components, or the engine — the 🎲 button flow is backend-agnostic and already handles the phrasings"

patterns-established:
  - "Prompt-only game-mechanics on the vault path: gate a static deterministic block on an existing campaign preference, reuse the existing client surface, preserve the read-only locked hash"

requirements-completed: [REQ-036]

# Metrics
duration: ~5min (automated) + operator smoke
completed: 2026-05-28
---

# Phase 05 Plan 01: manualRolls-gated `## Rolls` Block Summary

**The vault-path Dungeon Master now calls for ability checks, saving throws, and attack/damage rolls via the existing manual-roll surface — a `manualRolls`-gated `## Rolls` block (language- and DC-aware) was added to `buildVaultSystemPrompt` (REQ-036), wired from `userPrefs` at the turn-route vault branch, reusing the client 🎲 button flow with zero parser/engine changes and REQ-022 byte-stability preserved.**

## Performance
- **Duration:** ~5 min automated (Tasks 1–2) + operator smoke (Task 3)
- **Tasks:** 3 (2 auto/TDD, 1 blocking human-verify checkpoint)
- **Files modified:** 3

## Accomplishments
- Extended `VaultPromptInput` with `manualRolls?: boolean` + `showDifficultyNumbers?: boolean` and emitted a `## Rolls` block when `manualRolls === true`, placed after the apply_event/roster section and before the `Respond in language:` clause.
- Block content reproduced verbatim from 05-CONTEXT.md §"Exact block content (LOCKED)": when-to-roll + DC anchors (Easy 10 / Medium 15 / Hard 20), the authoritative-number contract, the bare-d20 + sheet-modifier rule for checks/saves, embedded-bonus for attacks/damage, parser-compatible IT/EN phrasings, and the hidden-difficulty variant.
- Gated on `manualRolls` ALONE (independent of `vaultMutations`); language-aware (`it` → Italian phrasings + anti-mixing clause; default → English) and DC-aware (`showDifficultyNumbers:false` → omit numeric DC + append hidden-difficulty line).
- Wired `manualRolls` + `showDifficultyNumbers` from `userPrefs` into the vault-branch `buildVaultSystemPrompt({...})` call (route.ts:310-311), mirroring the baked branch precedent.
- REQ-022 preserved: the read-only default (manualRolls undefined) stays byte-identical → existing locked hash `60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e` UNCHANGED. No forbidden non-deterministic constructs introduced (`__forbidden-patterns.ts` lint clean).
- Full prompt-builder suite green (49 tests); `pnpm tsc --noEmit` exits 0.
- Operator smoke on One Piece (gemma4, `manualRolls=true`): an uncertain action produced an Italian roll request + the 🎲 button rendered and resolved — confirmed by the operator.

## Task Commits
Each task was committed atomically:
1. **Task 1: RED content tests + extend VaultPromptInput + emit gated `## Rolls` block** — `a9e1190` (feat)
2. **Task 2: Wire manualRolls + showDifficultyNumbers into the vault-branch call** — `ff8933f` (feat)
3. **Task 3: Operator smoke (enable manualRolls on One Piece + verify 🎲 button)** — DATA change (campaign settings) + live verification; approved by operator.

_STATE progress at the checkpoint pause was committed as `81e5f35`._

## Files Created/Modified
- `src/ai/master/vault/prompt-builder.ts` — Added the two optional `VaultPromptInput` fields and the `manualRolls`-gated `## Rolls` block (each physical line an explicit array element; language/hideDC branching; no forbidden constructs).
- `tests/ai/master/vault/prompt-builder.test.ts` — New Phase 05 rolls-block describe block: gated presence/absence, gating-independent-of-vaultMutations, it/en phrasings, hideDC behavior, and REQ-022 1000-build stability for the new input combinations; existing locked-snapshot hash left UNCHANGED.
- `src/app/api/sessions/[id]/turn/route.ts` — Two-line addition inside the vault-branch `buildVaultSystemPrompt({...})` call forwarding `userPrefs.manualRolls` + `userPrefs.showDifficultyNumbers`.

## Decisions Made
- **Gating:** `manualRolls === true` only; `vaultMutations` is irrelevant to this block (tested with `{manualRolls:true, toolCount:3}`).
- **Modifier model:** Bare d20 for checks/saves (master reads the PC's sheet modifier from the vault and adds it at resolution); bonus embedded for attacks/damage. Matches the baked manual-roll model; modifier precision on bare-d20 checks is an accepted v1 soft spot (the reported problem was the master *not asking* for rolls).
- **Reuse, not import:** Mirrored `buildManualRollsRule`'s proven phrasings as self-contained vault content rather than importing from `system-prompt.ts`, keeping the vault/baked builders parallel (same precedent as Phase 04).

## Deviations from Plan
None. All three tasks executed as planned; Task 3 cleared via operator smoke.

## Issues Encountered
- None blocking. History-anchoring (the Phase 04 lesson) was flagged as a risk for the smoke, but gemma4 (steerable) produced the roll request on One Piece as expected.

## User Setup Required
- `manualRolls=true` enabled on the One Piece campaign (done via DB update during the checkpoint). Other vault campaigns are unaffected (block absent unless they opt in).

## Next Phase Readiness
- REQ-036 complete: the vault-path master now calls for rolls via the existing 🎲 surface.
- Out of scope / deferred (per 05-CONTEXT.md §Deferred): auto-roll / server-side RNG; combat state machine / initiative / monster spawning (piece D — a separate later phase); history-anchoring per-turn reminder; modifier-precision hardening.
- No blockers. Combat (piece D) can build on this — attacks are now rollable via the same surface.

## Self-Check: PASSED
- `05-01-SUMMARY.md` exists.
- Commits `a9e1190` and `ff8933f` exist in git history.
- `## Rolls` block present in `src/ai/master/vault/prompt-builder.ts`; 49/49 tests pass; `tsc --noEmit` exit 0; locked hash unchanged.

---
*Phase: 05-vault-ability-checks-manual-rolls*
*Completed: 2026-05-28*
