---
phase: 10-server-authoritative-combat-and-tracker
verified: 2026-06-01T09:00:00Z
status: passed
score: 5/5
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "CR-01 BLOCKER: extractMonsterName now strips the leading [Author] speaker prefix before verb/article stripping, so multi-PC sessions correctly extract the monster name (e.g. '[Aria] attacco il goblin' → 'goblin', not '[Aria]'). WR-01 also closed: English articles (the/an) added to the strip set. extractMonsterName extracted from route.ts inline closure into an exported, unit-tested function in encounter-opener.ts. route.ts imports and calls it. 7 regression tests added and green."
  gaps_remaining: []
  regressions: []
deferred: []
---

# Phase 10: Server-Authoritative Combat and Tracker — Verification Report

**Phase Goal:** Make combat encounter events server-authoritative (independent of local-model
tool-calling) and keep the vault combat tracker fresh, so fights reliably start, apply damage
only after the damage roll, advance turns, and update the right-pane tracker without a manual
refresh.

**Verified:** 2026-06-01T09:00:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (CR-01 + WR-01 gap fixed across commits 1ea481d and 6875b9f)

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | A player attacking an NPC reliably opens an encounter (monster_spawn + initiative_set) with real SRD stats, including multi-PC sessions, even when the local model emits zero tool calls | VERIFIED | `extractMonsterName` in `encounter-opener.ts` (lines 316-342) strips `[Author]` prefix via `.replace(/^\s*\[[^\]]*\]\s*/, '')` as the first step, then strips EN/IT articles (including `the`/`an`) before the capitalized-word match. `route.ts` line 40 imports it, line 366 calls `extractMonsterName(_playerMessage ?? '')` — no inline closure remains. 7 regression tests pass: `'[Aria] attacco il goblin' → 'goblin'`, `'[Bryn] attack the goblin' → 'goblin'`, `'attack the goblin' → 'goblin'`, `'strike an ogre' → 'ogre'`, plus 3 single-PC controls. Composition proof: route extracts `'goblin'` → `getBestiaryStatblock('goblin')` → `{hpMax:7,ac:15,cr:'1/4'}` → `runEncounterOpener` spawns goblin with hpMax 7. |
| 2 | Damage is applied only after the damage roll; no damage number appears before the roll (REQ-047) | VERIFIED | `runEncounterOpener` returns exactly `[monster_spawn, initiative_set]` — no hp-delta events. Gate ordering `!isRollResult` before `detectCombatIntent` prevents damage-before-roll re-trips. 4 REQ-047 tests green. v1 two-step resolver preserved. |
| 3 | Monster turns resolve server-side and the tracker reflects PC and monster HP plus the turn pointer within one turn (pre-existing v2 loop; no regression) | VERIFIED | All 39 Phase-10 tests pass. Full suite: 6 pre-existing failures (game-client-begin-stuck, preferences-local-validation, scene-image-coalesce, tts-coalesce, applicator, job-claims/flaky). No Phase-10-introduced regression. tsc --noEmit clean. |
| 4 | The combat tracker recovers via snapshot refetch when the completion SSE is dropped (REQ-046), including the empty-narration case | VERIFIED | `combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan` (route.ts line 852) branches the empty-narration else. When true → `notifySession(sessionId, {type:'state'})` (line 858, silent refetch). `use-session-stream.ts:113-116` maps `state` → `refetch()`. `game-client.tsx` has `void refetch()` at lines 238 and 297 for dropped-SSE durability. 9 branch-decision tests green. |
| 5 | No regression; suite green except known pre-existing failures; tsc clean | VERIFIED | The two gap-fix commits (1ea481d, 6875b9f) only touched `encounter-opener.ts`, `encounter-opener.test.ts`, and `route.ts`. v1/v2 files (combat-resolver, monster-turns, combat-handoff, projector, events-schema) confirmed unmodified. 6 failing tests match the documented pre-existing baseline exactly. tsc --noEmit clean. |

**Score: 5/5 truths verified**

---

## CR-01 / WR-01 Gap Closure (Re-verification focus)

The BLOCKER from the initial verification is now CLOSED. Evidence chain for must-have #1:

**Commit 1ea481d (RED):**
- Extracts `extractMonsterName` from the inline closure in `route.ts` into an exported, directly unit-testable function in `encounter-opener.ts`.
- Ports the original buggy logic faithfully so 4 new regression tests fail RED (CR-01: multi-PC prefix not stripped; WR-01: English articles not stripped).
- 3 single-PC controls + 14 existing `runEncounterOpener` tests remain green.

**Commit 6875b9f (GREEN):**
- Adds `.replace(/^\s*\[[^\]]*\]\s*/, '')` as the first transformation in `extractMonsterName` — anchored at start, strips the `[CharName]` author prefix written by route.ts `usePrefix` logic before verb/article stripping runs.
- Adds `the` and `an` to the article alternation regex (WR-01).
- `route.ts` line 40: `import { runEncounterOpener, extractMonsterName } from './encounter-opener'`.
- `route.ts` line 366: `const monsterName = extractMonsterName(_playerMessage ?? '')` — replaces the removed inline `_extractMonsterName` closure.
- No inline `_extractMonsterName` definition anywhere in route.ts (confirmed: `grep const _extractMonsterName route.ts` → no output).

**Test results (confirmed by orchestrator):** 39 existing phase-10 tests + 7 new `extractMonsterName` regression tests all pass. Full suite at baseline (5 stable pre-existing failures + job-claims flaky).

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|---------|---------|--------|---------|
| `src/app/api/sessions/[id]/turn/encounter-opener.ts` | Pure `runEncounterOpener(snapshot, monsterName, bestiaryLookup) → CombatEvent[]` + exported `extractMonsterName(msg) → string` | VERIFIED | 342 lines. Both functions exported. `extractMonsterName` strips `[Author]` prefix, then EN/IT verbs and articles, then extracts first capitalized word group. Never throws. |
| `tests/app/api/sessions/[id]/turn/encounter-opener.test.ts` | RED→GREEN tests for happy path, empty-party→[], REQ-047, null-bestiary fallback + CR-01/WR-01 regression suite | VERIFIED | 26 tests (19 existing + 7 new extractMonsterName tests), all pass. Controls for single-PC pass. 4 CR-01/WR-01 cases confirmed green. |
| `src/app/api/sessions/[id]/turn/monster-bestiary.ts` | `getBestiaryStatblock(name) → {hpMax?,ac?,cr?}|null` + `getBestiaryAttackStats` | VERIFIED | Both exports present. Reads frontmatter via `readVaultFile → safeVaultPath`. Returns `{hpMax:7, ac:15, cr:'1/4'}` for goblin. |
| `tests/app/api/sessions/[id]/turn/monster-bestiary-statblock.test.ts` | RED→GREEN: goblin real stats + null for unknown + traversal safe | VERIFIED | 5 tests, all pass. |
| `src/app/api/sessions/[id]/turn/route.ts` | Imports `extractMonsterName`, calls it at line ~366, no inline closure | VERIFIED | Line 40 imports `extractMonsterName`. Line 366 calls `extractMonsterName(_playerMessage ?? '')`. No `_extractMonsterName` inline definition anywhere in the file. |
| `tests/app/api/sessions/[id]/turn/encounter-opener-wiring.test.ts` | Goblin intent → real SRD hpMax (7) | VERIFIED | 5 tests pass. |
| `tests/app/api/sessions/[id]/turn/empty-narration-notify.test.ts` | Branch decision: combat→state, non-combat→turn-error | VERIFIED | 9 tests, all pass. |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `route.ts` | `encounter-opener.ts (runEncounterOpener)` | call at gated combat-intent branch | VERIFIED | Import line 40; call line 376. |
| `route.ts` | `encounter-opener.ts (extractMonsterName)` | import + call before bestiary lookup | VERIFIED | Import line 40; call line 366 — `extractMonsterName(_playerMessage ?? '')`. No inline closure. |
| `route.ts` | `monster-bestiary.ts (getBestiaryStatblock)` | injected as opener's `bestiaryLookup` | VERIFIED | Import line 39; pre-awaited line 375; injected as `() => _bestiaryStats` line 376. |
| `route.ts` | `dispatchVaultTool` with `campaignId + sessionId` | opener event dispatch | VERIFIED | Line 383: `dispatchVaultTool('apply_event', ev, { campaignId: campaign.id, sessionId })`. |
| `route.ts (empty-narration else)` | `notify.ts notifySession({type:'state'})` | `combatStateChanged` guard | VERIFIED | Line 852: `const combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan`. Line 858: `notifySession(sessionId, {type:'state'})`. |
| `notify.ts {type:'state'}` | `use-session-stream.ts → refetch()` | EventSource state handler | VERIFIED | `use-session-stream.ts` lines 113-115: `case 'state': case 'dice': refetch(); break;`. |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---------|--------------|--------|-------------------|--------|
| `encounter-opener.ts` | `hpMax` in `monster_spawn.payload` | `bestiaryLookup(monsterName)` injected from route | YES — `getBestiaryStatblock` reads committed `data/vault/handbook/monsters/goblin.md` frontmatter | VERIFIED (both single-PC and multi-PC: `extractMonsterName` now correctly resolves monster name in all cases) |
| `monster-bestiary.ts getBestiaryStatblock` | `hpMax`, `ac`, `cr` | `readVaultFile` → `safeVaultPath` → frontmatter parse | YES | VERIFIED |
| `route.ts opener hook` | `monsterName` passed to `getBestiaryStatblock` | `extractMonsterName(_playerMessage ?? '')` | YES — `[Aria] attacco il goblin` → `'goblin'`; `attack the goblin` → `'goblin'` | VERIFIED (CR-01 closed) |
| `use-session-stream.ts` | snapshot after combat events | `refetch()` triggered by `{type:'state'}` SSE | YES | VERIFIED |

---

## Behavioral Spot-Checks

| Behavior | Status |
|---------|--------|
| `extractMonsterName('[Aria] attacco il goblin')` returns `'goblin'` (CR-01 fixed) | PASS — confirmed by test + code read |
| `extractMonsterName('attack the goblin')` returns `'goblin'` (WR-01 fixed) | PASS — confirmed by test + code read |
| `extractMonsterName('attacco il goblin')` returns `'goblin'` (single-PC, control) | PASS |
| `extractMonsterName('strike an ogre')` returns `'ogre'` | PASS |
| All 39 existing Phase-10 turn tests | PASS — confirmed by orchestrator |
| 7 new extractMonsterName regression tests | PASS — confirmed by orchestrator |
| tsc --noEmit clean | PASS |
| Full suite: no new failures beyond documented baseline | PASS — 6 pre-existing failures only |

---

## Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|---------------|-------------|--------|---------|
| REQ-045 | 10-01, 10-02, 10-03 | Server opens encounter with real SRD stats; no dependency on local model tool calls; multi-PC sessions included | VERIFIED | `extractMonsterName` (exported, unit-tested) strips `[Author]` prefix before verb/article stripping. Route calls it for all sessions. `getBestiaryStatblock` returns real SRD values. 7 regression tests including 2 multi-PC cases confirm the fix. |
| REQ-046 | 10-04 | Tracker reflects encounter state within one turn, including dropped SSE; empty-narration combat turn triggers `{type:'state'}` not `{type:'turn-error'}` | VERIFIED | `combatStateChanged` guard branches empty-narration else. `use-session-stream.ts:113-116` maps `state` → silent `refetch()`. |
| REQ-047 | 10-01, 10-03 | Damage applied only after damage roll; opener never emits HP-change events | VERIFIED | `runEncounterOpener` returns only `[monster_spawn, initiative_set]`. Gate includes `!isRollResult`. REQ-047 tests confirm 0 damage events. |

---

## Anti-Patterns Found

| File | Location | Pattern | Severity | Impact |
|------|----------|---------|---------|--------|
| `tests/…/encounter-opener-wiring.test.ts` | Test #5 (line 268) | Brittle regex on `route.ts` source text for production-sessionId assertion (WR-04) | WARNING | Breaks on harmless reformats. Non-blocking. |
| `encounter-opener.ts` | `roll1d20()` call for monster initiative, line ~274 | `initiativeBonus` not read from `getBestiaryStatblock` (goblin has `initiativeBonus: 2` in frontmatter) — WR-02 | WARNING | Monster initiative is always 1d20+0; SRD accuracy discarded. Non-blocking; improvement left to a future phase. |

No BLOCKER anti-patterns found. CR-01 is resolved.

---

## Human Verification Required

None. All must-haves verified programmatically. The multi-PC smoke test previously listed as a gap confirmation is now superseded by the 7 passing regression tests that directly assert the correct behavior.

---

## Gaps Summary

No gaps. All 5 must-haves are VERIFIED.

The single BLOCKER from the initial verification (CR-01: `extractMonsterName` returning the PC bracket-name in multi-PC sessions) is closed by commits 1ea481d and 6875b9f. The fix is correct, minimal, and covered by 7 regression tests.

---

_Verified: 2026-06-01T09:00:00Z_
_Verifier: Claude (gsd-verifier) — re-verification after gap closure_
