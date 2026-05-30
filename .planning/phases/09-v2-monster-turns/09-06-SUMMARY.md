---
phase: 09
plan: 06
subsystem: vault-combat-v2-route-integration
tags: [monster-turns, route-wiring, integration, narration-binding, checkpoint-pending, D-01, D-02, D-12, D-13, D-16]
# Dependency graph (for forward-planning agents)
requires:
  - "src/app/api/sessions/[id]/turn/monster-turns.ts (09-04: runMonsterTurnLoop — injectable bestiaryLookup seam; returns {results, events, stopReason, partyDown, narrationDirective})"
  - "src/app/api/sessions/[id]/turn/monster-bestiary.ts (09-03: getBestiaryAttackStats — async, null on miss, never throws)"
  - "src/ai/master/vault/turn-directive.ts (09-05: buildTurnDirective accepts monsterResolved?: boolean)"
  - "src/ai/master/vault/projector.ts (09-01: EncounterState.monsters[].cr; replayEvents → {chars, encounter}; chars carry per-character hp_current)"
  - "src/app/api/sessions/[id]/turn/combat-resolver.ts (08: ResolveCombatResult, enforceResolvedNarration, resolveCombat)"
provides:
  - "Live v2 monster-turn chain: the vault turn route runs runMonsterTurnLoop on a live-monster active actor, emits its events server-side, and binds the combined narration via enforceResolvedNarration whenever the loop ran"
affects:
  - "src/app/api/sessions/[id]/turn/route.ts (vault branch — monster-turn loop hook)"
# Tech stack signals (for pattern matching)
tech-stack: [typescript, nextjs-16, vitest, drizzle-orm]
patterns: [post-resolution-loop-hook, server-authoritative-event-emission, defensive-try-catch-wrap, combined-single-pass-narration, recency-directive-stacking, narration-binding-on-loop-ran]
key-files:
  created: []
  modified:
    - "src/app/api/sessions/[id]/turn/route.ts"
key-decisions:
  - "Consume loop.narrationDirective directly (built ONCE by runMonsterTurnLoop, D-15) rather than calling the exported buildMonsterLoopNarrationDirective again in the route — avoids a redundant second build; the route imports only runMonsterTurnLoop + getBestiaryAttackStats."
  - "PC current HP sourced from the replayEvents chars map (chars.get(pcId).hp_current), NOT from snap.party (which carries only the static hpMax row field) — confirmed RESEARCH Open Q1 / Pitfall 1; falls back to the characters-row hpMax when a PC is absent from the chars map."
  - "enforceResolvedNarration binding is gated on _monsterLoopRan FIRST (then _resolver), with a ResolveCombatResult-shaped object cast via `as unknown as ResolveCombatResult` (kind:'resolved' is not in the union {to-hit|damage|none}; only the damageRequest:null strip-behavior is wanted, so the cast is intentional and documented inline)."
  - "Loop runs OUTSIDE the DB transaction (RESEARCH Anti-Pattern), in the same dispatchVaultTool('apply_event', …) emit pattern as the v1 _resolver block, immediately after it (route ~line 423)."
requirements-completed: [D-01, D-02, D-12, D-13, D-16]
# Metrics
duration: ~15 min (autonomous task; operator smoke checkpoint pending)
completed: 2026-05-30
---

# Phase 09 Plan 06: Wire Monster-Turn Loop into the Vault Turn Route Summary

**Wired the v2 monster-turn loop into the vault branch of `src/app/api/sessions/[id]/turn/route.ts`: immediately after the v1 `_resolver` emission + post-turn read, the route detects a live-monster active actor in the post-v1 `EncounterState`, builds the PC-AC map from a targeted Postgres `{id, ac, hpMax}` select (D-12) and the PC current-HP map from the replayed `CharacterState` chars map, runs `runMonsterTurnLoop` in the same request OUTSIDE the DB transaction (D-02), emits each `hp_change`/`turn_advance` server-side via `dispatchVaultTool('apply_event', …)` (D-13), passes `monsterResolved` to `buildTurnDirective` + extends `suppressCombatMutations` (D-16), injects the loop's ONE combined narration directive (D-15), and binds the final narration via `enforceResolvedNarration` WHENEVER `_monsterLoopRan` (D-01 common-path correctness) — all wrapped defensively so a loop failure never hard-fails the turn. The autonomous task is complete, `tsc` is clean, and the combat/turn/vault/sessions suites are green; the operator-smoke CHECKPOINT (Task 2, One Piece / Veyra) is PENDING.**

## STATUS: AUTONOMOUS WORK COMPLETE — CHECKPOINT PENDING

This plan is `autonomous: false`. Task 1 (the route wiring) is **done + committed** (`b3f9c0e`). Task 2 is a `checkpoint:human-verify` operator smoke (live One Piece campaign, custom monster "Veyra") that the executor cannot perform headlessly. **The plan is NOT yet complete** — it awaits the operator typing "approved" (or reporting divergence), after which a continuation agent finalizes.

## Performance

- **Duration (autonomous task):** ~15 min
- **Tasks:** 1 of 2 done (Task 2 = pending human-verify checkpoint)
- **Files modified:** 1 (`route.ts`; +132 / −7)

## Accomplishments (Task 1)

- **D-01/D-02 hook:** Added the monster-turn block immediately after the v1 `_resolver` emit loop (route ~line 423), before `buildTurnDirective`. Reads the post-v1 encounter via `replayEvents(await parseEventsFile(eventsPath(campaign.id)))`; if `encounter.active` and `turnOrder[currentIdx].actorId` resolves to a LIVE `monsters[]` entry, runs `runMonsterTurnLoop`. The common D-01 path (player attacks → v1 resolver fires → turn advances to a monster → loop runs, BOTH in the same request) is the primary flow.
- **D-12 PC-AC bridge + PC-HP map:** A targeted `db.select({ id, ac, hpMax }).from(charactersTable)` (campaign-scoped, `deletedAt` null, `templateId` not-null) builds `pcAcById` (`characters.ac` is `notNull`). `pcHpById` is built from the replay `chars` map (`chars.get(pc.id).hp_current`), falling back to the row `hpMax` when a PC is absent from the chars map (RESEARCH Pitfall 1 / Open Q1: `snap.party` does NOT carry live HP).
- **D-13 server-side emission:** Each `loop.events` entry (`hp_change` / `turn_advance`) is emitted via the same `dispatchVaultTool('apply_event', ev, { campaignId: campaign.id })` pattern as the v1 resolver — OUTSIDE the DB transaction (RESEARCH Anti-Pattern). `campaignId` is server-authoritative (T-09-18).
- **D-16 suppression:** `buildTurnDirective` receives `monsterResolved: _monsterLoopRan`; the `suppressCombatMutations` gate is extended from `_resolver !== null` to `(_resolver !== null || _monsterLoopRan)` so the LLM's combat `apply_event` calls are dropped on a server-resolved monster turn (belt-and-suspenders with the directive suppression, T-09-20).
- **D-15 combined narration:** The loop's ONE `narrationDirective` (built once by `runMonsterTurnLoop`) is injected via `appendDirectiveToHistory`, recency-stacked AFTER the player directive so on the common path the combined monster outcome wins the recency position. ONE narration LLM call for the whole monster sequence (M4 latency constraint).
- **W3 / D-01 CORRECTNESS — final-narration binding:** `enforceResolvedNarration` is now bound whenever `_monsterLoopRan` (checked FIRST, before `_resolver`), using a `ResolveCombatResult`-shaped object with `damageRequest: null` — so even on the common player-attack-then-monster-loop request (where `_resolver` is ALSO set) the final text is sanitized (competing roll-asks / leaked event-JSON stripped, nothing appended). NOT gated on `_resolver` alone.
- **Defensive (D-10 / T-09-19):** The whole monster block is in `try/catch`; a loop failure logs and resolves to `_monsterLoopRan = false` / no directive — the player's turn never hard-fails.
- **Handoff preserved:** The post-loop `resolveCombatHandoff` region (07-03) is untouched; the loop's emitted `turn_advance` events mean the post-loop encounter read already reflects the advanced turn.
- **Regression-safe:** The monster block only activates on a live-monster active actor; the new `enforceResolvedNarration` branch only changes behavior when `_monsterLoopRan`. Non-combat + player-attack-only paths are unchanged.

## Key Files

- `src/app/api/sessions/[id]/turn/route.ts` — the only modified file. Added: imports (`runMonsterTurnLoop` from `./monster-turns`, `getBestiaryAttackStats` from `./monster-bestiary`, `type ResolveCombatResult` from `./combat-resolver`); the monster-turn loop block (PC-AC/PC-HP maps, gate, loop, server-side emit, defensive wrap); `monsterResolved` on the `buildTurnDirective` call; the combined-directive injection; the extended `suppressCombatMutations` gate; and the rewritten `_finalNarration` binding (`_monsterLoopRan` → `_resolver` → plain). No other source file touched (monster-turns.ts / turn-directive.ts / tools.ts / prompt-builder.ts / events-schema.ts / projector.ts are owned by completed sibling plans and were consumed, not edited).

## Verification (Task 1 — automated)

- `npx tsc --noEmit` — **EXIT 0, clean** (project-wide).
- `npx vitest run tests/app/api/sessions/[id]/turn/monster-turns.test.ts tests/app/api/sessions/[id]/turn/combat-resolver.test.ts tests/ai/master/vault/turn-directive.test.ts` — **199 passed / 0 failed (EXIT 0)** (the plan's `<verify>` triad: the code this task wires + the v1 resolver + the directive regression).
- `npx vitest run "tests/app/api/sessions/[id]/turn/"` — **149 passed / 0 failed (EXIT 0)** (full turn/ directory, 4 files).
- `npx vitest run tests/ai/master/vault` — **728 passed / 0 failed (EXIT 0)**.
- `npx vitest run tests/sessions` — **859 passed / 0 failed (EXIT 0)**.
- No new failures introduced. The 4 documented pre-existing failures (applicator inventory, scene-image-coalesce, tts-coalesce, preferences-local-validation) live in `tests/api/*` + `tests/lib/*` — outside this plan's scope (logged in `.planning/phases/09-v2-monster-turns/deferred-items.md`).
- Acceptance-criteria greps (all PASS): `runMonsterTurnLoop(` (1 in vault branch); `monsterResolved:` (passed to buildTurnDirective); `charactersTable.ac` (PC-AC bridge select); `_resolver !== null || _monsterLoopRan` (extended suppress gate); `dispatchVaultTool('apply_event'` (loop emit); `enforceResolvedNarration` bound under `if (_monsterLoopRan)`.

## Decisions Made

- **Consume `loop.narrationDirective` directly (do not re-call `buildMonsterLoopNarrationDirective`).** 09-04's `runMonsterTurnLoop` builds the ONE combined directive internally and returns it (D-15: built once). The route injects that returned value rather than re-importing/re-calling the exported builder, avoiding a redundant second build. The route therefore imports only `runMonsterTurnLoop` + `getBestiaryAttackStats`.
- **PC current HP from the replay `chars` map, not `snap.party`.** Confirmed against `buildSnapshot` (snapshot.ts:401-409): `snap.party[]` carries the static character row (`ac`, `hpMax`) but NOT live HP. The same `replayEvents` call used for the encounter gate also yields `chars` (`Map<id, CharacterState>`); `chars.get(pc.id).hp_current` is the live HP, with a row-`hpMax` fallback (RESEARCH Open Q1).
- **`ResolveCombatResult`-shaped object via `as unknown as ResolveCombatResult`.** `ResolveCombatResult.kind` is the union `'to-hit' | 'damage' | 'none'`; the monster path is conceptually "resolved" with no single damage-request, so the object is constructed with `damageRequest: null` and cast. Only `enforceResolvedNarration`'s strip behavior is wanted (it appends nothing when `damageRequest` is null), so the cast is safe and documented inline. (Plan body suggested `kind: 'none'`; the `as unknown as` cast keeps the intent explicit and tsc-clean without overloading a real `'none'` semantic.)
- **Loop gate keyed on `loop.results.length > 0` for `_monsterLoopRan`.** The loop "ran" iff it actually resolved ≥1 monster turn; a `pc-turn` / empty stop with no results leaves `_monsterLoopRan` false so the turn behaves exactly as the player-only path (regression safety).

## Deviations from Plan

### 1. [Process — discarded a speculative test file] Removed an invalid route unit test written against an imagined route shape

- **Found during:** Task 1, initial implementation attempt.
- **Issue:** I first wrote a `route-monster-loop.test.ts` (and attempted route edits) against an idealized synchronous `route.ts` shape (a `POST` returning `{ narration, encounter, resolved }`, with collaborators like `@/sessions/replay`, `@/ai/master/vault/context-loader`, `projectEncounterState`). The ACTUAL `route.ts` is the `waitUntil(...)` background-task architecture: `POST` returns 202 immediately and runs the master loop in the background — there is no synchronous return of narration, and those collaborator modules do not exist. The speculative edits correctly failed (strings not found); the speculative test produced 33 tsc errors (missing modules, `NextRequest` typing, etc.).
- **Fix:** Discarded the speculative test file entirely (it was never committed; `git status` confirms only `route.ts` changed) and re-implemented against the real route. The plan's `files_modified` is `route.ts` ONLY and its `<verify>` block specifies the EXISTING sibling suites (`monster-turns.test.ts`, `combat-resolver.test.ts`, `turn-directive.test.ts`) — no new route test was required or in scope. The real route's `POST`-returns-202 + background-`waitUntil` shape is not amenable to a simple synchronous unit test, consistent with the plan calling for the route behavior to be exercised by the operator smoke (Task 2), not a new automated route test.
- **Files modified:** none beyond `route.ts` (the bad test file + its `__tests__` dir were removed, leaving no trace).
- **Verification:** `tsc --noEmit` EXIT 0 after removal; `git status --short` shows only `route.ts` modified among source files.

**Total deviations:** 1 (process — a discarded speculative artifact, no impact on delivered code or scope). The route wiring matches the plan's `<action>` steps 1-8 against the real route structure.

## Issues Encountered

- **`--reporter=basic` is not a valid vitest 4.x flag in this repo.** The first verification runs passed `--reporter=basic`, which vitest 4.1.5 tried to load as a custom reporter module (`Failed to load url basic`) and exited 1 — a FLAG error, not a test failure. Re-running with the default reporter showed all suites green. (No bearing on the delivered code.)
- **Intermittent tool-output staleness during reads.** Several `Read`/`Bash` calls returned a generic "Wasted call — file unchanged" reminder or stale piped output (the same harness instability the 09-04 / 09-05 SUMMARYs documented). Worked around by routing verification through temp-file writes read back with the Read tool and ASCII-only `printf` verdict lines. Final authoritative results: `tsc` EXIT 0; vitest triad 199/199; turn/ 149/149; vault 728/728; sessions 859/859.

## Threat Coverage (Task 1)

All `mitigate` dispositions in the plan's threat_model are satisfied by the route wiring:
- **T-09-18 (Tampering / monster id + target):** the loop reads the active monster + targets from the server-resolved `EncounterState` + the party PC-id set; the player supplies neither. Every `dispatchVaultTool` uses `campaign.id` (server-authoritative).
- **T-09-19 (DoS / loop in HTTP request):** the loop is bounded by `MONSTER_LOOP_SAFETY_CAP` (09-04) and runs OUTSIDE the DB transaction; the whole block is in `try/catch` and never breaks the turn.
- **T-09-20 (Info-disclosure / Tampering — LLM leaks or re-emits):** `suppressCombatMutations` extended to the loop turn (drops the LLM's combat `apply_event` calls) AND `buildTurnDirective` receives `monsterResolved` (no combat re-ask); the FINAL narration is passed through `enforceResolvedNarration` whenever `_monsterLoopRan` (damageRequest:null) so leaked event-JSON / competing roll-requests are stripped even on the common D-01 path.
- **T-09-21 (DoS / hp_change underflow):** the loop clamps working HP (09-04) and the existing `hp_change` reducer clamps `max(0, hp+delta)` — applied unchanged via the dispatcher.
- **T-09-SC (supply chain):** no package installs in this plan.

No new security surface beyond the plan's threat_model. No stubs.

## CHECKPOINT PENDING — Task 2 (operator smoke, human-verify)

**The plan is NOT complete.** Task 2 is a `checkpoint:human-verify` the executor cannot perform headlessly. The operator must run the live app and confirm the end-to-end Veyra monster turn. Exact steps (from the plan's `<how-to-verify>`):

1. Ensure the One Piece campaign is `sourceOfTruth:'vault'` with `vaultMutations` enabled (Phase 07/08 left it so; otherwise flip via the existing settings).
2. Start/resume a One Piece session and get into combat with **Veyra** (custom monster, `cr`-table path) so Veyra is a live actor in `turnOrder`. Take a player ATTACK action on your turn that ends with Veyra as the active actor (exercises the COMMON path: v1 resolves your attack, then the turn advances to Veyra and the monster loop runs in the SAME request).
3. Observe: the server resolves Veyra's attack — the CombatTracker shows YOUR PC's HP drop (hp_change applied), the turn advances back to you, and the master narration describes BOTH your attack's outcome AND Veyra's hit/miss in 2nd-person Italian WITHOUT asking you to roll for the monster and WITHOUT printing raw event JSON or a competing "Tira …" roll-request.
4. Confirm consecutive monster turns (if >1 monster is live) resolve in the SAME response (one narration), and the turn returns to a PC.
5. Confirm a normal NON-combat turn and a player-attack turn with NO monster following still behave exactly as before (no regression).

**Resume signal:** the operator types "approved" if Veyra's attack resolves server-side (PC HP drops, turn advances, combined Italian narration with no monster roll-ask / no leaked JSON even on the attack-then-monster path, handoff back to PC, non-combat/v1-only unchanged); otherwise they describe what diverged (→ gap-closure plan).

## Next Phase Readiness

- The full v2 monster-turn chain is now wired end-to-end across 09-01..09-06. Pending the operator smoke (Task 2), Phase 09 is functionally complete.
- A continuation agent (post-"approved") should: finalize STATE.md/ROADMAP.md, mark the phase complete, and (if the smoke surfaced a divergence) spin a gap-closure plan rather than editing inline.
- No blockers introduced by Task 1. No sibling-plan files were modified.

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/route.ts` — FOUND on disk (modified).
- `.planning/phases/09-v2-monster-turns/09-06-SUMMARY.md` — FOUND on disk.
- Commit `b3f9c0e` (feat 09-06 route wiring) — FOUND in git log; touches ONLY `route.ts`; no deletions.
- Consumed exports verified present: `runMonsterTurnLoop` + `buildMonsterLoopNarrationDirective` (monster-turns.ts), `getBestiaryAttackStats` (monster-bestiary.ts), `monsterResolved?: boolean` (turn-directive.ts).
- `npx tsc --noEmit` → EXIT 0, clean.
- Plan `<verify>` triad → 199/199 passed, EXIT 0. Full turn/ → 149/149. Vault → 728/728. Sessions → 859/859.
- All 6 acceptance-criteria greps → PASS.
- Scope: exactly ONE source file (`route.ts`) modified; no sibling-plan files touched; no tracked-file deletions.

---
*Phase: 09-v2-monster-turns*
*Status: Task 1 complete + committed; Task 2 (operator-smoke checkpoint) PENDING*
*Completed (autonomous task): 2026-05-30*
