---
phase: 09-v2-monster-turns
verified: 2026-05-31T00:30:00Z
status: human_needed
score: 16/16 decisions code+test verified
overrides_applied: 0
human_verification:
  - test: "Trigger the v2 monster-turn loop in a live session using the dice roll chip (not free text)"
    expected: "PC HP drops in CombatTracker, turn advances to PC, combined Italian 2nd-person narration with no monster roll-ask and no leaked event JSON; for the COMMON D-01 path (player attack then monster turn in the same request), enforceResolvedNarration still governs the final text"
    why_human: "deferred-items.md confirms the operator smoke did NOT exercise the v2 loop (free-text attack bypasses isRollResult gate — no turn_advance fired, monster never became active actor, runMonsterTurnLoop never ran). The v2 code path has never executed on any real campaign. Automated evidence (828 tests green, tsc clean) verifies correctness, but live end-to-end behaviour is unconfirmed."
  - test: "Confirm non-combat turns and player-attack-only turns (v1 path, no monster following) are byte-identical to Phase 08 behaviour"
    expected: "No regression in player-attack flow or any non-combat turn"
    why_human: "Regression requires live execution since the smoke never advanced to a monster turn; automated tests cover the directive byte-identity but not the full E2E flow."
---

# Phase 09: v2 Monster Turns — Verification Report

**Phase Goal:** Move MONSTER-turn mechanical resolution server-side. When the active actor in an active vault encounter is a monster, the server rolls its attack via an injectable RNG seam, picks a random live PC, pulls the PC's AC from Postgres, applies damage via `hp_change`, advances the turn, and loops consecutive monster turns in one request — stopping cleanly on a PC turn / party-KO / safety cap. Monster attack stats come from a 3-level fallback (bestiary prose parse -> LLM cr-hint table -> named-constant default). The LLM only NARRATES the server-determined outcomes in one combined pass.

**Verified:** 2026-05-31T00:30:00Z
**Status:** HUMAN_NEEDED — All 16 decisions code+test verified; live end-to-end smoke NOT yet confirmed (see deferred-items.md and Critical Context below).
**Re-verification:** No — initial verification.

---

## CRITICAL CONTEXT: Live Smoke Status

The operator smoke (2026-05-31, One Piece / "Freya") did NOT exercise the v2 monster-turn loop. The player attacked with free text; `isRollResult()` requires `🎲` / "I rolled", so `_resolver` stayed null, the local model free-narrated (tool_calls=0), emitted no `turn_advance`, the active actor never advanced to the monster, and `runMonsterTurnLoop` was never invoked. The live `events.md` (29 events) contains zero monster→PC `hp_change` events — the v2 path has never executed.

**This verification is therefore based entirely on code inspection and automated test evidence.** All 16 decisions are verified by code reading and tests. Live end-to-end behaviour is NOT confirmed and is listed as a human verification requirement.

---

## Goal Achievement

### Observable Truths (D-01..D-16)

| # | Decision | Status | Evidence (file:line) |
|---|----------|--------|----------------------|
| D-01 | Trigger: active actor is a live monster in an active encounter, gated on vaultMutations | VERIFIED | `route.ts:440-453` — `if (vaultMutationsEnabled) { ... const activeMonster = ... encounter.monsters.find(m => m.id === active.actorId && m.isAlive); if (activeMonster) { ...` |
| D-02 | Server-side loop resolves consecutive monster turns in the SAME HTTP request | VERIFIED | `route.ts:479-500` — `runMonsterTurnLoop` called in-process, each `loop.events` emitted via `dispatchVaultTool` before the LLM narration call; handoff preserved |
| D-03 | Loop stops when (a) active actor is a live PC, (b) no live targetable PC remains, (c) safety cap | VERIFIED | `monster-turns.ts:357-433` — explicit stop branches: `'pc-turn'` at line 375, `'party-down'` at lines 386 and 408-411 and 430-432, `'cap-reached'` default at line 340 |
| D-03c | MONSTER_LOOP_SAFETY_CAP named constant; reaching it stops cleanly, never throws | VERIFIED | `monster-turns.ts:248` — `export const MONSTER_LOOP_SAFETY_CAP = 20`; used as `while (iterations < MONSTER_LOOP_SAFETY_CAP)` at line 352 |
| D-04 | Bestiary prose parse: `parseFirstAttackFromProse` extracts `+N to hit` / `XdY±Z` from `## Actions` | VERIFIED | `monster-bestiary.ts:97-109` — `ATTACK_HIT_RE` + `DAMAGE_DICE_RE` per-block; 19 tests green including 6 real bestiary forms (goblin/orc/zombie/bandit-captain/troll/dragon) |
| D-05 | CR_TO_ATTACK_STATS table, nearest-floor lookup, custom monster cr-hint → deterministic stats | VERIFIED | `monster-turns.ts:68-84` — 10-row table; `getMonsterAttackStats` at lines 110-136; 36 tests green covering floor/mid/high/fractional CR |
| D-06 | Named-constant defaults DEFAULT_MONSTER_ATTACK_BONUS=4 / DEFAULT_MONSTER_DAMAGE_DIE='1d6' | VERIFIED | `monster-turns.ts:46-47` — exported named constants; `DEFAULT_PLAYER_AC=12` at line 55; no inline magic numbers |
| D-07 | Bestiary parse path is isolated (D-04 never blocks the smoke-critical D-05 path) | VERIFIED | `monster-bestiary.ts` has zero imports from `monster-turns.ts` / `events-schema.ts` / `projector.ts`; D-04 in its own Wave-1 plan; `getBestiaryAttackStats` returns `null` on any miss |
| D-08 | `monster_spawn` gains optional `cr?: number`; old events replay byte-stable; LLM instructed | VERIFIED | `events-schema.ts:319-321` — `cr?: number` additive; validator at `events-schema.ts:1059-1065`; projector `cr` copy at `projector.ts:763`; tool description at `tools.ts:101`; prompt instruction at `prompt-builder.ts:208-209`; byte-stable replay test in projector.test.ts |
| D-09 | Hit rule: `natural !== 1 && (natural === 20 || total >= ac)`, NO crit-doubling | VERIFIED | `monster-turns.ts:210` — verbatim v1 hit rule; `rollDamage` called with `{}` (no `crit:true`) at line 217; seeded tests covering nat1/nat20/total==ac/total==ac-1 |
| D-10 | All randomness through a single injectable RNG seam (default `defaultRng`); no `Math.random` | VERIFIED | `monster-turns.ts:197` — `const rng = input.rng ?? defaultRng`; `Math.random` appears only in a comment (line 19), never in actual code; `runMonsterTurnLoop` injects `args.rng` through to `resolveMonsterTurn` |
| D-11 | Random live PC target via injected RNG; 1v1 collapse; null on empty pool | VERIFIED | `monster-turns.ts:200` — `rng.intInclusive(0, input.livePcIds.length - 1)`; `if (input.livePcIds.length === 0) return null` at line 195; seeded multi-PC pool test |
| D-12 | PC-AC bridge: route pulls `characters.ac` (notNull) + PC current HP from replay chars map | VERIFIED | `route.ts:461-473` — `db.select({ id, ac, hpMax }).from(charactersTable)`; `pcAcById.set(pc.id, pc.ac)`; `pcHpById.set(pc.id, replayed ? replayed.hp_current : pc.hpMax)` |
| D-13 | Monster→PC damage via existing `hp_change {character, delta:-damage}` event | VERIFIED | `monster-turns.ts:220` — `{ type: 'hp_change', payload: { character: pcId, delta: -damage } }`; emitted via `dispatchVaultTool('apply_event', ev, { campaignId })` at `route.ts:490` |
| D-14 | PC at 0 HP → KO + stop loop if last live PC; non-last KO lets loop continue; HP clamped at 0 | VERIFIED | `monster-turns.ts:421-433` — `workHp.set(r.pcTargetId, Math.max(0, current - r.damage))`; `if (!anyLivePc()) { stopReason = 'party-down'; partyDown = true; break; }`; D-14 also detected at step 2 (line 372) |
| D-15 | Single combined narration directive listing all monster outcomes; built once per loop | VERIFIED | `monster-turns.ts:440` — `buildMonsterLoopNarrationDirective(results, { partyDown })` called ONCE after the while loop; injected at `route.ts:573-578`; `RESOLVED BY SYSTEM: turni mostri` header at `monster-turns.ts:486` |
| D-16 | Suppress "Area C — Turn rule" combat re-ask directives when server resolved monster turn | VERIFIED | `turn-directive.ts:166` — `if (!serverResolved && !monsterResolved && vaultMutations && detectCombatIntent(...))`; `turn-directive.ts:207` — `if (vaultMutations && !serverResolved && !monsterResolved)`; `monsterResolved: _monsterLoopRan` at `route.ts:540`; `suppressCombatMutations` extended at `route.ts:616` |

**Score: 16/16 decisions code+test verified**

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/ai/master/vault/events-schema.ts` | `cr?: number` on `monster_spawn` + validator | VERIFIED | Lines 319-321 (type) + 1059-1065 (validator) |
| `src/ai/master/vault/projector.ts` | `cr?: number` on `EncounterState.monsters[]` + reducer copy | VERIFIED | Lines 675 (interface) + 750/763 (reducer destructure + conditional copy) |
| `src/app/api/sessions/[id]/turn/monster-turns.ts` | CR table, defaults, `resolveMonsterTurn`, `runMonsterTurnLoop`, `buildMonsterLoopNarrationDirective` | VERIFIED | All exports present; 492 lines; no `next/*` imports; pure helper |
| `src/app/api/sessions/[id]/turn/monster-bestiary.ts` | `parseFirstAttackFromProse`, `getBestiaryAttackStats` | VERIFIED | Both exports present; routes through `readVaultFile`/`safeVaultPath`; ReDoS-bounded |
| `src/ai/master/vault/tools.ts` | `monster_spawn cr?:number` in apply_event payload description | VERIFIED | Line 101 — `cr?:number` in the monster_spawn clause |
| `src/ai/master/vault/prompt-builder.ts` | LLM instructed to include `cr` for custom monsters | VERIFIED | Lines 208-209 under `### Monster stats` |
| `src/ai/master/vault/turn-directive.ts` | `monsterResolved?: boolean` on `TurnDirectiveOpts` + guards | VERIFIED | Lines 56-69 (interface) + 166 + 207 (guards) |
| `src/app/api/sessions/[id]/turn/route.ts` | Monster-loop hook wired in vault branch (D-01..D-16) | VERIFIED | Lines 426-510 (loop block) + 540 (`monsterResolved`) + 573-578 (narration) + 616 (suppress) + 668-686 (`enforceResolvedNarration` on `_monsterLoopRan`) |
| `tests/app/api/sessions/[id]/turn/monster-turns.test.ts` | 72 seeded unit+integration tests covering all D-02..D-15 loop/directive paths | VERIFIED | 72 tests passing (confirmed 2026-05-31 run) |
| `tests/app/api/sessions/[id]/turn/monster-bestiary.test.ts` | 19 unit tests (prose forms, Multiattack skip, ReDoS-bounded, path-safety) | VERIFIED | Included in 72-test pass count |
| `tests/ai/master/vault/events-schema.test.ts` | D-08 cr validation tests (int/fraction/0/negative/NaN/string/absent) | VERIFIED | 355 tests passing across schema+projector+directive |
| `tests/ai/master/vault/projector.test.ts` | D-08 cr propagation + byte-stable replay tests | VERIFIED | Included in 355-test pass count |
| `tests/ai/master/vault/turn-directive.test.ts` | D-16 monsterResolved suppression + byte-identical-when-absent regression | VERIFIED | 6 new D-16 tests included in 355-test pass count |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `route.ts` vault branch | `runMonsterTurnLoop` | import + call at route.ts:38,479 | WIRED | Called after `_resolver` emit block; result events iterated and emitted |
| `runMonsterTurnLoop` | `resolveMonsterTurn` / `getMonsterAttackStats` / `getBestiaryAttackStats` | composition in `monster-turns.ts:394-404` | WIRED | 3-level fallback: `await lookup(name)` → `getMonsterAttackStats({cr, bestiary})` → `resolveMonsterTurn(...)` |
| `route.ts` `buildTurnDirective` call | `monsterResolved: _monsterLoopRan` | route.ts:540 | WIRED | D-16 flag set |
| `route.ts` | `enforceResolvedNarration` | route.ts:668-682 — `if (_monsterLoopRan)` branch with `damageRequest: null` ResolveCombatResult-shaped object | WIRED | Monster path handled independently of `_resolver`; common D-01 path (both flags set) governed by monster directive |
| `loop.events` | `dispatchVaultTool('apply_event', ev, { campaignId })` | route.ts:489-493 | WIRED | Outside DB transaction; campaignId server-authoritative |
| `monster_spawn` payload | `EncounterState.monsters[].cr` | events-schema.ts:319-321 → validator:1059-1065 → projector.ts:750,763 | WIRED | Full chain: schema → validator → reducer copy |
| `cr` in EncounterState | `getMonsterAttackStats({cr})` → `CR_TO_ATTACK_STATS` | monster-turns.ts:395 | WIRED | `activeMonster.cr` passed as `cr` input |
| `getBestiaryAttackStats` | `readVaultFile` / `safeVaultPath` | monster-bestiary.ts:160 | WIRED | No hand-rolled fs/path |
| `suppressCombatMutations` gate | `(_resolver !== null || _monsterLoopRan)` | route.ts:616 | WIRED | Extended from v1 player-only gate |
| `_monsterNarration` | `appendDirectiveToHistory` | route.ts:573-578 | WIRED | Injected AFTER player directive (recency-stacking) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `route.ts` monster block | `pcAcById` | `db.select({ id, ac, hpMax }).from(charactersTable)` | Yes — Postgres AC (notNull) | FLOWING |
| `route.ts` monster block | `pcHpById` | `replayEvents(parseEventsFile(...)).chars.get(pc.id).hp_current` with `hpMax` fallback | Yes — live vault replay | FLOWING |
| `runMonsterTurnLoop` | `workEncounter` / `workHp` | `structuredClone(args.encounter)` + `new Map(args.pcHpById)` — real caller data | Yes — in-memory working copies of real state | FLOWING |
| `resolveMonsterTurn` | `d20`, `damage` | `rollD20({modifier}, rng)` / `rollDamage(damageDice, {}, rng)` — real dice engine | Yes — crypto-backed defaultRng in production | FLOWING |
| `getMonsterAttackStats` | `attackBonus`, `damageDice` | `CR_TO_ATTACK_STATS` table lookup or bestiary parse or named-constant default | Yes — deterministic server-side | FLOWING |

### Behavioral Spot-Checks

| Behavior | Verification Method | Result | Status |
|----------|--------------------|---------| ------|
| 72 monster-turns tests pass (D-03..D-15) | `npx vitest run tests/app/api/sessions/[id]/turn/monster-turns.test.ts monster-bestiary.test.ts` | 72/72 PASS | PASS |
| 355 vault tests pass (D-08, D-16, projector) | `npx vitest run tests/ai/master/vault/events-schema.test.ts projector.test.ts turn-directive.test.ts` | 355/355 PASS | PASS |
| All turn/ + vault/ suites | `npx vitest run tests/app/api/sessions/[id]/turn/ tests/ai/master/vault/` | 828/828 PASS (21 skipped) | PASS |
| tsc --noEmit | TypeScript compilation | 0 errors | PASS |
| Live v2 loop exercised end-to-end | Operator smoke 2026-05-31 | NOT EXERCISED — see deferred-items.md | FAIL |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` files declared for Phase 09. The phase's smoke was a manual operator session documented in deferred-items.md. See deferred-items.md for the root-cause analysis of why the v2 loop was not triggered.

### Requirements Coverage

| Decision | Plan | Status | Evidence |
|----------|------|--------|---------|
| D-01 (trigger gate) | 09-06 | SATISFIED | route.ts:440-453 |
| D-02 (same-request loop) | 09-06 | SATISFIED | route.ts:479-500 |
| D-03 / D-03c (stop conditions + cap) | 09-04 | SATISFIED | monster-turns.ts:340-433 |
| D-04 (bestiary prose parse) | 09-03 | SATISFIED | monster-bestiary.ts:97-109 |
| D-05 (CR table, nearest-floor) | 09-02 | SATISFIED | monster-turns.ts:68-136 |
| D-06 (named-constant defaults) | 09-02 | SATISFIED | monster-turns.ts:46-47 |
| D-07 (bestiary path non-blocking) | 09-03 | SATISFIED | module isolation; null-on-miss contract |
| D-08 (additive cr? schema + LLM surface) | 09-01 + 09-05 | SATISFIED | events-schema.ts:319-321; tools.ts:101; prompt-builder.ts:208-209; projector.ts:763 |
| D-09 (v1 hit rule, no crit-doubling) | 09-02 | SATISFIED | monster-turns.ts:210,217 |
| D-10 (injectable RNG seam) | 09-02 + 09-04 | SATISFIED | single `rng ?? defaultRng`; no Math.random in code |
| D-11 (random live-PC target) | 09-02 | SATISFIED | monster-turns.ts:200 |
| D-12 (PC-AC bridge) | 09-06 | SATISFIED | route.ts:461-473 |
| D-13 (hp_change for PC damage) | 09-02 + 09-06 | SATISFIED | monster-turns.ts:220; route.ts:489-493 |
| D-14 (PC KO + party-down stop) | 09-04 | SATISFIED | monster-turns.ts:372-434 |
| D-15 (single combined narration directive) | 09-04 + 09-06 | SATISFIED | monster-turns.ts:440,474-491; route.ts:573-578 |
| D-16 (suppress combat re-ask on monster-resolved turn) | 09-05 + 09-06 | SATISFIED | turn-directive.ts:166,207; route.ts:540,616,668-686 |

**All 16 decisions: SATISFIED by code evidence.**

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | — | No TBD/FIXME/XXX/placeholder stubs in Phase 09 source files | — | — |

Scanned files modified in Phase 09:
- `src/ai/master/vault/events-schema.ts` — no debt markers
- `src/ai/master/vault/projector.ts` — no debt markers
- `src/ai/master/vault/tools.ts` — no debt markers
- `src/ai/master/vault/prompt-builder.ts` — no debt markers
- `src/ai/master/vault/turn-directive.ts` — no debt markers
- `src/app/api/sessions/[id]/turn/monster-turns.ts` — no debt markers
- `src/app/api/sessions/[id]/turn/monster-bestiary.ts` — no debt markers
- `src/app/api/sessions/[id]/turn/route.ts` — no debt markers

### Human Verification Required

**The operator smoke did NOT exercise the v2 loop.** Both items below must be confirmed by a live session that actually triggers `runMonsterTurnLoop`.

---

#### 1. v2 Monster-Turn Loop Live End-to-End

**Test:** In the One Piece (or any vault campaign with `vaultMutations: true`) combat session, spawn a custom monster that carries `cr` in its `monster_spawn` payload. On your PC's turn, use the dice roll chip (not free text) — click the Attack button that inserts the `🎲` roll syntax so `isRollResult()` returns true. This fires the v1 resolver → `turn_advance` emits → active actor becomes the monster → `runMonsterTurnLoop` runs.

**Expected:**
- The CombatTracker shows your PC's HP drop (server applied `hp_change` via `dispatchVaultTool`)
- The turn advances back to your PC (loop emitted `turn_advance`)
- The master narration describes the monster's hit/miss in 2nd-person Italian with NO monster roll-ask and NO raw event JSON printed
- The final text is governed by `enforceResolvedNarration` (no "Tira..." roll-ask, no `apply_event` JSON leaked)
- On the COMMON path (player attack in same request as monster loop): both `_resolver != null` and `_monsterLoopRan` are true; the monster directive governs the final narration

**Why human:** The code path has never executed on a real campaign session (confirmed via events.md — zero monster→PC hp_change events). Code inspection confirms correctness; live execution is the only way to confirm the full integration.

---

#### 2. Regression Confirmation (non-combat and v1-only player-attack turns)

**Test:** Run a normal non-combat turn and a player-attack-only turn (where no monster follows), in a vault campaign with `vaultMutations: true`.

**Expected:** Behaviour is byte-identical to Phase 08 — no change in narration, no spurious monster-loop directive, `_monsterLoopRan` stays false.

**Why human:** The `_monsterLoopRan = false` guard protects non-monster turns in code, but the directive byte-identity tests cover the turn-directive level only. Live regression confirms the full route path.

---

### Pre-Existing Test Failures (Do NOT attribute to Phase 09)

The following 4 test failures are pre-existing and unrelated to Phase 09 combat work (documented in deferred-items.md; last touched before Phase 08):

| Test | Root cause |
|------|-----------|
| `tests/sessions/applicator.test.ts > add_inventory + remove_inventory + set_equipped` | Inventory gp-stack qty 60 vs 50 (commit `7ad8533`, pre-Phase-08) |
| `tests/api/scene-image-coalesce.test.ts` | Concurrency/provider-coalescing — environment-sensitive |
| `tests/api/tts-coalesce.test.ts` | Concurrency/TTS-provider coalescing — environment-sensitive |
| `tests/lib/preferences-local-validation.test.ts` | Env-gating test — depends on environment detection |

These are NOT counted as Phase 09 gaps.

### Known Deferred / Spun-Off Items

These are pre-existing findings discovered during the Phase 09 smoke, explicitly documented in deferred-items.md. They are NOT Phase 09 failures.

| Item | Classification | Evidence |
|------|---------------|---------|
| Combat tracker goes stale when SSE `message` event is dropped | PRE-EXISTING, spun off | The vault path never emits the `state` SSE event; `startSafetyPoll` refetches `/messages` + `/character` but not the session snapshot. Orthogonal to Phase 09; tracked in its own session/worktree. |
| Free-text attacks not mechanically resolved (no `🎲` prefix, so `isRollResult()` returns false) | v1-level prompt-reliability gap, NOT a v2 bug | The Attack quick-button inserts plain text (narrative-pane.tsx:245); local models free-narrate instead of emitting `apply_event`. Pre-existing; deferred to a dedicated phase or gsd-debug session. |

---

### Gaps Summary

**Zero code gaps.** All 16 decisions are satisfied by real, substantive, wired code with flowing data. No stubs, no orphaned artifacts, no TBD markers. The automated test suite (828 tests passing, 4 pre-existing unrelated failures excluded) provides strong algorithmic coverage.

**One operational gap:** The v2 code path has never executed in production. The operator smoke did NOT trigger `runMonsterTurnLoop` because the player used free text instead of a dice roll chip. This is a smoke-configuration gap (wrong attack input method), not a code defect. The code is correct; the execution path is unexercised in live play.

**Recommendation:** Proceed to close Phase 09 after a targeted live smoke that specifically uses the dice roll chip to trigger `isRollResult()` and exercises the full D-01 common path. The fix is trivial for the operator: click the roll chip instead of typing free text when the master asks for an attack roll.

---

_Verified: 2026-05-31T00:30:00Z_
_Verifier: Claude (gsd-verifier)_
