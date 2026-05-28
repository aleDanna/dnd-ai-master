---
phase: 05-vault-ability-checks-manual-rolls
verified: 2026-05-28T21:11:00Z
status: passed
score: 8/8 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  gaps_closed:
    - "showDifficultyNumbers:false (English) DC 14 leak — fixed in commit 7fff4fd: hideDC English branch now emits 'Roll a Dexterity save.' with no DC number; test (e) hardened to regex /\\bDC\\s*\\d/ catching any numeric DC leak; Italian hideDC guard test (e-it) added"
    - "One Piece campaign manualRolls=true operator smoke — confirmed: DB query returned settings.manualRolls='true' for One Piece (campaign id prefix 3ef630db, model gemma4:latest); live smoke approved by operator (Italian roll request + 🎲 button rendered and resolved)"
  gaps_remaining: []
  regressions: []
---

# Phase 05: Vault Ability Checks (Manual Rolls) Verification Report

**Phase Goal:** The vault-path Dungeon Master calls for ability checks, saving throws, and attack/damage rolls via the existing manual-roll surface — a `manualRolls`-gated `## Rolls` block in `buildVaultSystemPrompt`; prompt + setting only; no parser/engine/tool changes; REQ-022 byte-stability preserved.
**Verified:** 2026-05-28T21:11:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (previous status: human_needed, 7/8)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `buildVaultSystemPrompt` emits `## Rolls` block when and only when `manualRolls === true` | VERIFIED | `if (input.manualRolls === true)` gate at prompt-builder.ts:280; tests (a) absent, (b) absent, (c) present — all pass; 50/50 tests pass |
| 2 | Block contains `Easy 10, Medium 15, Hard 20`, `AUTHORITATIVE`, bare-d20+modifier rule | VERIFIED | prompt-builder.ts:111,115,119-121; test (c) asserts all tokens; confirmed in passing suite |
| 3 | Italian language yields Italian phrasings + anti-mixing clause; English (default) yields English phrasings | VERIFIED | prompt-builder.ts:125-155 language branch; Italian: `Tira una prova di Percezione (CD 15).`, `Tira un TS Destrezza (CD 14).`, anti-mixing clause; English: `Roll a DC 15 Perception check.`, `Roll a DC 14 Dexterity save.`; test (d) asserts all; 50/50 pass |
| 4 | `showDifficultyNumbers:false` omits numeric DC/AC from examples and adds hidden-difficulty line | VERIFIED | English hideDC=true branch (prompt-builder.ts:144-148): `"Roll a Dexterity save."` — no DC number (fixed in commit 7fff4fd). Test (e) uses regex `/\bDC\s*\d/` + `/\bCD\s*\d/`; test (e-it) guards Italian variant; both pass; `Hidden difficulty` line confirmed present |
| 5 | REQ-022 preserved: read-only default hash `60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e` UNCHANGED | VERIFIED | Hash constant appears 2× in test file unmodified; locked-snapshot test passes; `manualRolls` undefined/false adds zero bytes |
| 6 | 1000-build byte-stability holds for all new input combinations | VERIFIED | Tests (g), (h), (i) pass: 1 unique hash for `{manualRolls:true}`, `{manualRolls:true, language:'it'}`, `{manualRolls:true, showDifficultyNumbers:false}` — 50/50 tests pass |
| 7 | `turn/route.ts` vault branch passes `manualRolls` + `showDifficultyNumbers` from `userPrefs` | VERIFIED | route.ts:310-311: `manualRolls: userPrefs.manualRolls` and `showDifficultyNumbers: userPrefs.showDifficultyNumbers` inside the vault-branch `buildVaultSystemPrompt({...})` call (lines 296-312) |
| 8 | One Piece campaign has `manualRolls=true` enabled (operator smoke step) | VERIFIED | DB query confirmed `settings.manualRolls='true'` for One Piece campaign (id prefix `3ef630db`, model `gemma4:latest`); live smoke approved by operator: Italian roll request produced + 🎲 button rendered and resolved |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/ai/master/vault/prompt-builder.ts` | `manualRolls?` + `showDifficultyNumbers?` fields + gated `## Rolls` block | VERIFIED | Both fields added to `VaultPromptInput` (lines 81-89); `buildRollsBlock` helper (lines 102-162); gated emission at lines 280-287; `## Rolls` appears 3 times in source (`grep -c '## Rolls'` → 3) |
| `tests/ai/master/vault/prompt-builder.test.ts` | REQ-022 stability assertions (existing hash UNCHANGED) + Phase 05 gated content/language/hideDC/block-absent tests | VERIFIED | Phase 05 describe block at lines 321-424; 10 new tests (a)-(i) + (e-it) all pass; locked hash constant unmodified (2×); 50/50 total tests pass |
| `src/app/api/sessions/[id]/turn/route.ts` | `manualRolls` + `showDifficultyNumbers` wired from `userPrefs` at vault-branch call site | VERIFIED | Lines 310-311 forward both fields; baked branch precedent at lines 613/628 also present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `VaultPromptInput.manualRolls` | `## Rolls` block emission | `if (input.manualRolls === true) { ... }` at prompt-builder.ts:280 | WIRED | Exact pattern `manualRolls.*true` confirmed at line 280 |
| `turn/route.ts buildVaultSystemPrompt` call | `userPrefs.manualRolls` / `userPrefs.showDifficultyNumbers` | Object literal at lines 310-311 | WIRED | Both fields forwarded verbatim from `userPrefs`; grep confirms 4 matches (2 vault branch + 2 baked branch) |
| `## Rolls` block phrasings | `roll-parser.ts parseRollRequests` patterns #4/#5 (Italian) and #2/#3 (English) | Italian: `Tira una prova di`; English: `Roll a DC` | WIRED | Both phrasings present in prompt-builder.ts (lines 135, 150); parser unchanged by design (prompt-only phase) |

### Data-Flow Trace (Level 4)

Not applicable — `buildVaultSystemPrompt` is a pure string-builder (no DB access, no component rendering). The block content is statically constructed from input booleans (`manualRolls`, `language`, `showDifficultyNumbers`). Data flow verified by wiring checks above and by the REQ-022 purity gate (no forbidden non-deterministic constructs found).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite (50 tests) | `pnpm vitest run tests/ai/master/vault/prompt-builder.test.ts` | 50 passed, 0 failed | PASS |
| TypeScript typecheck | `pnpm tsc --noEmit` | Exit code 0 (no output) | PASS |
| Locked hash constant present and unchanged | `grep "60e56767..." tests/ai/master/vault/prompt-builder.test.ts` | 2 hits | PASS |
| No forbidden patterns in source | `grep -nE 'Date\.now\|Math\.random\|process\.env\|new Date\|randomUUID\|process\.hrtime' prompt-builder.ts` | No output | PASS |
| `## Rolls` block present in source | `grep -c '## Rolls' prompt-builder.ts` | 3 | PASS |
| English hideDC no DC-number leak | hideDC=true English branch emits `"Roll a Dexterity save."` | No `DC \d` or `CD \d` in output; regex test (e) passes | PASS |
| vault-branch wiring | `grep -n "manualRolls.*userPrefs\|userPrefs.*manualRolls" route.ts` | Lines 310, 613 | PASS |

### Probe Execution

No probes declared for this phase (prompt-only phase, same pattern as Phase 04).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| REQ-036 | 05-01-PLAN.md | Vault-path master calls for ability checks / saving throws / attack+damage rolls via manual-roll surface; parser-compatible roll requests; gated on `manualRolls`; REQ-022 preserved | SATISFIED | `buildRollsBlock` helper + `manualRolls === true` gate implemented and wired in route.ts; 50/50 tests pass; operator smoke confirmed on One Piece |
| REQ-022 | 05-01-PLAN.md | Prefix-cache hygiene: system prompt is a pure function; no `Date.now`/`Math.random`/`process.env`/`randomUUID`/`process.hrtime`; locked hash unchanged | SATISFIED | Forbidden-pattern lint test passes; locked hash `60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e` UNCHANGED; `tsc --noEmit` exits 0 |

### Anti-Patterns Found

No anti-patterns found. The previous WARNING (English hideDC DC 14 leak) is resolved: prompt-builder.ts:146 now emits `"Roll a Dexterity save."   (saving throw — no DC)` in the `hideDC=true` English branch. No `TBD`/`FIXME`/`XXX` debt markers found in modified files.

### Human Verification Required

None. All items are resolved:

- The English `hideDC=true` DC-14 leak was a code defect now fixed and verified by the hardened regex test (e).
- The One Piece campaign `manualRolls=true` DB state was confirmed by direct DB query (campaign id prefix `3ef630db`, model `gemma4:latest`) and live operator smoke (Italian roll request produced + 🎲 button rendered and resolved).

Model obedience (the master writes Italian roll requests and the button renders) is confirmed by the operator smoke — same verified-in-smoke pattern as Phase 04, not unit-testable.

### Gaps Summary

No gaps. All 8 must-haves are VERIFIED. The two items that blocked the previous verification are both closed:

1. **hideDC English DC-14 leak (code fix):** The English `hideDC=true` saving throw example was corrected in commit `7fff4fd`. The line now reads `"Roll a Dexterity save."` (no DC number). Test (e) was hardened from a string-equality check to a regex assertion (`/\bDC\s*\d/`, `/\bCD\s*\d/`) that catches any numeric DC/CD leak from any example. A new Italian hideDC guard test (e-it) was also added. All 50 tests pass.

2. **One Piece campaign DB state (operator-confirmed smoke):** The DB query returned `settings.manualRolls='true'` for the One Piece campaign. The live smoke was approved by the operator. This is the same automated-vs-smoke verification split used in Phase 04: unit tests verify the prompt contains the instruction; model obedience is observed in the smoke, not unit-tested.

---

_Verified: 2026-05-28T21:11:00Z_
_Verifier: Claude (gsd-verifier)_
