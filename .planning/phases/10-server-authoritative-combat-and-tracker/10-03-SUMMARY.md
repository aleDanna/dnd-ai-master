---
phase: 10-server-authoritative-combat-and-tracker
plan: "03"
subsystem: api
tags: [combat, encounter-opener, route-wiring, server-authoritative, bestiary, dispatch]
dependency_graph:
  requires:
    - phase: 10-server-authoritative-combat-and-tracker/10-01
      provides: runEncounterOpener (pure encounter opener function)
    - phase: 10-server-authoritative-combat-and-tracker/10-02
      provides: getBestiaryStatblock (async SRD frontmatter reader)
  provides:
    - Opener trigger wired into route.ts vault branch (REQ-045 end-to-end)
    - openerRan boolean signal for 10-04 empty-narration guard
    - Headless wiring proof: goblin hpMax === 7 from real SRD (BLOCKER-1 acceptance)
  affects:
    - src/app/api/sessions/[id]/turn/route.ts (10-04 will extend openerRan usage)

tech_stack:
  added: []
  patterns:
    - "Async→sync bridge: pre-await getBestiaryStatblock, inject sync closure () => stats into runEncounterOpener"
    - "Cross-plan signal: openerRan boolean declared at vault-branch scope for 10-04"
    - "Gated opener hook: !isBegin && vaultMutationsEnabled && detectCombatIntent && !isRollResult && !encounter.active"
    - "Headless dispatch: dispatchVaultTool without sessionId → no Postgres NOTIFY (tools.ts:200)"

key_files:
  created:
    - tests/app/api/sessions/[id]/turn/encounter-opener-wiring.test.ts
  modified:
    - src/app/api/sessions/[id]/turn/route.ts

decisions:
  - "Async/sync seam: pre-await getBestiaryStatblock before the pure runEncounterOpener call; inject () => stats closure. The Promise would otherwise be treated as a stats object, hpMax falling back to CR-default (confirmed by BLOCKER-1 test: hpMax 7 proves SRD path, not fallback)"
  - "openerRan referenced in the empty-narration else-branch console.warn (with sessionId) to satisfy noUnusedLocals without adding 10-04 logic prematurely; 10-04 will replace this with the full combatStateChanged guard"
  - "Monster-name extraction: Option B (isolated in _extractMonsterName inline function per CONTEXT.md LOCKED decision) — strips common IT/EN attack-verb prefixes and picks the first capitalized word group; falls back to first non-empty word then 'Unknown Enemy'. Seam is isolated so option A replaces only this step"
  - "isRollResult check ordered BEFORE detectCombatIntent in the gate (T-10-13): roll-result messages echo attack verbs and would otherwise re-trip combat intent"
  - "Dispatch pattern: { campaignId: campaign.id, sessionId } — both fields required (T-10-07: server UUID never player-derived; sessionId required for emitStateRefresh)"
  - "try/catch wraps entire opener hook (D-10/T-10-09): a failure logs + falls through, openerRan stays false, turn continues as normal vault narration turn"

metrics:
  duration_seconds: 720
  completed_date: "2026-06-01"
  tasks_completed: 2
  files_created: 1
  files_modified: 1
---

# Phase 10 Plan 03: Opener Route Wiring + Headless Dispatch Proof — Summary

**One-liner:** Gated encounter-opener hook in route.ts wires getBestiaryStatblock→runEncounterOpener→dispatchVaultTool; headless test proves goblin spawns at SRD hpMax 7, no Postgres NOTIFY.

## What Was Built

### Task 1: route.ts opener wiring

The vault branch of `route.ts` now contains a server-authoritative encounter opener hook (Phase 10 / REQ-045). On a real player turn where:
- `masterBackend === 'vault'` AND `vaultMutationsEnabled` are true
- `detectCombatIntent(_playerMessage)` returns true (attack verbs detected)
- `isRollResult(_playerMessage)` returns false (not a dice roll — avoids re-opening on roll echoes)
- `!isBegin` (not the synthetic scene-opening begin turn)
- `encounter.active === false` (no encounter already open)

...the route:
1. Derives the monster name from `_playerMessage` via `_extractMonsterName` (Option B — isolated seam)
2. Pre-awaits `getBestiaryStatblock(monsterName)` (async SRD reader from 10-02)
3. Calls `runEncounterOpener(snap, monsterName, () => stats)` — synchronous closure bridges the async/sync seam
4. Dispatches each returned event via `dispatchVaultTool('apply_event', ev, { campaignId: campaign.id, sessionId })`
5. Sets `openerRan = true` after successful dispatch

The `openerRan` boolean is declared at the same vault-branch scope as `_resolver` and `_monsterLoopRan`, making it visible to the empty-narration else-branch for 10-04's `combatStateChanged` guard.

**REQ-047 invariant held:** `runEncounterOpener` (10-01) never emits damage events; the opener hook dispatches only the events the pure function returns.

**v1/v2 stack untouched:** No changes to combat-resolver, monster-turns, monster-bestiary (existing functions), combat-handoff, projector, or events-schema.

### Task 2: Headless wiring test

`tests/app/api/sessions/[id]/turn/encounter-opener-wiring.test.ts` (5 tests) proves the end-to-end wiring path:

1. **BLOCKER-1 acceptance:** `getBestiaryStatblock('goblin')` → `stats.hpMax === 7` → `runEncounterOpener` with sync closure → `monster_spawn.hpMax === 7` (REAL SRD value from `data/vault/handbook/monsters/goblin.md`, NOT the CR-default 11)
2. **Initiative membership:** `initiative_set.order` contains the PC UUID AND the monster id, with `length === party.length + 1`
3. **REQ-047:** No `monster_hp_change` / `hp_change` event in the opener output
4. **Headless dispatch:** Each opener event dispatched via `dispatchVaultTool` with `{ campaignId }` only (no `sessionId`) → events land in `events.md` → `encounter.active === true` with PC UUID + monster id in `turnOrder` — no Postgres NOTIFY attempted (tools.ts:200: `emitStateRefresh` is a no-op when `sessionId` is absent)
5. **Production sessionId assertion:** Verifies `route.ts` source contains `{ campaignId: campaign.id, sessionId }` at the opener dispatch site (proves production wiring fires `emitStateRefresh`)

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | 08ebd68 | feat(10-03): wire server-authoritative encounter opener into route.ts |
| 2 | c70696c | test(10): wiring proof — goblin opener uses real SRD hpMax, no real NOTIFY |

## Verification Results

- `grep WIRED_OK`: openerRan declared, runEncounterOpener and getBestiaryStatblock wired
- `tsc --noEmit`: CLEAN (no errors)
- Wiring test (5/5 GREEN): goblin hpMax 7, initiative PC+monster, no damage, headless dispatch, production sessionId verified
- Full suite: 5 pre-existing failures (game-client-begin-stuck, preferences-local-validation, scene-image-coalesce, tts-coalesce, applicator) — unchanged, no new failures

## Deviations from Plan

### Deviation 1 [Rule 3 — Auto-fix]: openerRan forward declaration requires a read reference

**Found during:** Task 1 TypeScript compilation

**Issue:** TypeScript's `noUnusedLocals` flagged `let openerRan = false` as unused when 10-04's `combatStateChanged` guard doesn't exist yet in this plan.

**Fix:** Added `openerRan` to the existing `console.warn` in the empty-narration else-branch: `console.warn('turn produced empty response (vault path)', { sessionId, openerRan })`. This satisfies the TypeScript compiler, makes the cross-plan contract explicit in a comment, and is replaced by 10-04's full `combatStateChanged` logic.

**Files modified:** `src/app/api/sessions/[id]/turn/route.ts`

**Commit:** 08ebd68

### Deviation 2 [Wave 1 seam note]: Async/sync bridge required pre-awaiting

**Context:** The wave1 integration notes in the execution prompt correctly identified the seam: `getBestiaryStatblock` is `async` but `runEncounterOpener`'s `bestiaryLookup` parameter is synchronous. The plan's action section also documented this seam.

**Implementation:** `const _bestiaryStats = await getBestiaryStatblock(monsterName); const openerEvents = runEncounterOpener(snap, monsterName, () => _bestiaryStats);` — pre-await the async function, inject the resolved value via synchronous closure.

**Proof:** The BLOCKER-1 test asserts `monster_spawn.hpMax === 7` end-to-end. If the closure had been omitted (passing a Promise), the opener would treat the Promise object as stats, `hpMax` would be undefined, and the CR fallback (11 for goblin's CR 1/4 → tier 0 → 7 actually, but the ac/cr fields would be lost) would fire. Test proves wiring is correct.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns beyond what the plan's `<threat_model>` already covers:

- T-10-07 (Spoofing / campaignId): dispatch uses `campaign.id` (server UUID) + `sessionId` — never player-derived. Confirmed in dispatch call and by the production-assertion test.
- T-10-08 (Tampering / damage on open): opener hook dispatches only `runEncounterOpener`'s return value; that function never emits damage (proven by REQ-047 test assertion).
- T-10-09 (DoS / opener throwing): entire hook wrapped in `try/catch` → log + fall through; turn never hard-fails.
- T-10-13 (Tampering / regression on non-combat turns): gate is `masterBackend==='vault' && vaultMutationsEnabled && detectCombatIntent && !isRollResult && !isBegin`; baked, non-combat, roll-result, and begin turns are byte-identical.

## Known Stubs

None. The opener is fully wired: `getBestiaryStatblock` reads real SRD vault files, `runEncounterOpener` produces real events, and `dispatchVaultTool` persists them to `events.md` with both `campaignId` and `sessionId` (production path).

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/route.ts` — MODIFIED (confirmed: openerRan declared, runEncounterOpener imported and called)
- `tests/app/api/sessions/[id]/turn/encounter-opener-wiring.test.ts` — CREATED
- commit 08ebd68 — FOUND
- commit c70696c — FOUND
- `tsc --noEmit` — CLEAN
- Wiring test 5/5 GREEN
- No new test failures (5 pre-existing remain)
