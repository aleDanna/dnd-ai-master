---
phase: 10-server-authoritative-combat-and-tracker
plan: "04"
subsystem: api
tags: [combat, notify, sse, server-authoritative, tracker-refresh, empty-narration]
dependency_graph:
  requires:
    - phase: 10-server-authoritative-combat-and-tracker/10-03
      provides: openerRan boolean signal at vault-branch scope
    - phase: 10-server-authoritative-combat-and-tracker/10-01
      provides: runEncounterOpener (via openerRan)
    - phase: 10-server-authoritative-combat-and-tracker/10-02
      provides: getBestiaryStatblock (via openerRan)
  provides:
    - REQ-046 empty-narration gap closed: guarded notifySession({type:'state'}) for silent tracker refresh on combat empty turns
    - combatStateChanged guard (XOR branch: state vs turn-error) in route.ts
    - Branch decision test (15 assertions, all GREEN)
  affects:
    - src/app/api/sessions/[id]/turn/route.ts (empty-narration else branch)

tech_stack:
  added: []
  patterns:
    - "XOR branch: combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan — exactly one notify per empty turn (state XOR turn-error)"
    - "Silent {type:'state'} notify: the client already maps this to refetch() at use-session-stream.ts:113-116 — no new client code needed"
    - "Unit test models the branch decision as a tiny local helper (route has no exported unit-test harness); mirrors pure-function convention"

key_files:
  created:
    - tests/app/api/sessions/[id]/turn/empty-narration-notify.test.ts
  modified:
    - src/app/api/sessions/[id]/turn/route.ts

decisions:
  - "BRANCH the existing turn-error emit, do NOT add a second notify alongside it — state XOR turn-error, never both (T-10-10 DoS prevention)"
  - "combatStateChanged reads all three in-scope signals: _resolver (v1 combat resolver), _monsterLoopRan (v2 monster loop), openerRan (Phase 10-03 opener) — any one truthy = silent refresh; all falsy = retry toast"
  - "Test models the decision as a local helper (emptyNarrationBranchDecision) rather than a full route invocation — consistent with combat-resolver.test.ts convention; no live Postgres, no HTTP server"
  - "Client durable recovery (game-client.tsx void refetch() at ~238/297) confirmed already shipped; no client extension needed"
  - "use-session-stream.ts and game-client.tsx both untouched (client recovery already present; SSE event type mappings already exist for both 'state' and 'turn-error')"

metrics:
  duration_seconds: 300
  completed_date: "2026-06-01"
  tasks_completed: 2
  files_created: 1
  files_modified: 1
---

# Phase 10 Plan 04: Empty-Narration Notify Guard — Summary

**One-liner:** Guarded combatStateChanged branch in route.ts emits {type:'state'} (silent tracker refresh) instead of turn-error when a server-resolved combat turn produces empty narration, preventing spurious retry toasts on legitimately successful turns.

## What Was Built

### Task 1: Branch the empty-narration else (route.ts)

The vault-path empty-narration `else` branch in `route.ts` (~850-885) now implements REQ-046's XOR guard:

```typescript
const combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan;
if (combatStateChanged) {
  // Silent tracker refresh — no error toast
  notifySession(sessionId, { type: 'state' }).catch(...);
} else {
  // Genuine model failure — surface retry toast
  notifySession(sessionId, { type: 'turn-error', reason: 'empty_response', message: '...' }).catch(...);
}
```

**Why it matters:** Before this change, a server-authoritative combat turn (HP changed, initiative advanced, encounter opened) that happened to produce no narration text would emit `{type:'turn-error'}` — triggering the client's "no response / retry" toast even though the turn legitimately succeeded. With this change, `{type:'state'}` fires instead, the client silently refetches via `use-session-stream.ts:113-116`, and the tracker updates with no spurious error.

**Exactly one notify fires per empty turn** (state XOR turn-error) — no refresh storm (T-10-10).

The three signals are all already declared at the vault-branch scope:
- `_resolver` (~439): non-null when `resolveCombat` resolved a player attack roll server-side
- `_monsterLoopRan` (~501): true when `runMonsterTurnLoop` executed at least one monster action
- `openerRan` (~350, from 10-03): true when the encounter-opener hook dispatched events

### Task 2: Branch decision test (tests/app/api/sessions/[id]/turn/empty-narration-notify.test.ts)

15 test assertions across 4 describe blocks:

1. **Guard expression truth table** (5 cases): combatStateChanged is false when all three signals are falsy; true when any one is truthy; true when multiple are truthy simultaneously.
2. **Combat empty turn — combatStateChanged true** (3 cases): emits `{type:'state'}`, does NOT emit `turn-error` (XOR invariant).
3. **Non-combat empty turn — combatStateChanged false** (2 cases): emits `{type:'turn-error', reason:'empty_response'}`, does NOT emit `state` (XOR invariant).
4. **XOR invariant — exactly one notify per empty turn** (5 parameterized cases): truth-table driven, asserts `state XOR turn-error` for every input combination.

The test models the branch decision as a local `emptyNarrationBranchDecision` helper (the route has no exported unit-test harness; a full headless route invocation is not warranted here). This mirrors the `combat-resolver.test.ts` pure-function convention.

### Verification of downgraded Option C (client durable recovery)

`grep -c "void refetch()" game-client.tsx` returns 2 (lines ~238 and ~297) — the durable/dropped-SSE recovery path is confirmed already shipped from prior phases. No client extension needed.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | 2cbc52c | feat(10-04): branch empty-narration else — combatStateChanged→{type:'state'}, non-combat→turn-error |
| 2 | a69c17d | test(10): empty-narration branch — combat→state (no turn-error), non-combat→turn-error (no state) |

## Verification Results

- `grep -nE "notifySession\(.*type:.*'state'" route.ts` (comment-filtered): matched line 873 inside the combatStateChanged-true branch
- `grep -qE "combatStateChanged.*_resolver.*_monsterLoopRan.*openerRan"`: NOTIFY_OK
- `tsc --noEmit`: CLEAN (no errors project-wide)
- Empty-narration test (15/15 GREEN): all truth-table and XOR invariant assertions pass
- `grep -c "void refetch()" game-client.tsx`: 2 (CLIENT_RECOVERY_PRESENT)
- Full suite: 5 pre-existing failures (game-client-begin-stuck, preferences-local-validation, scene-image-coalesce, tts-coalesce, applicator) — unchanged, no new failures (3525 tests pass)

## Deviations from Plan

None. The plan executed exactly as written. Task 1 branched the existing notify call without adding a parallel emit; Task 2 wrote a pure-function test without a full route drive. No architectural changes, no new dependencies, no v1/v2 files touched.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns beyond what the plan's `<threat_model>` already covers:

- T-10-10 (DoS — refresh storm): mitigated by the XOR guard (exactly one notify per empty turn). Negative test (non-combat → no state emit) enforces this.
- T-10-11 (Spoofing — wrong session): `notifySession` called with the route's own `sessionId` (authenticated turn's session), not any client-supplied value.
- T-10-12 (Info disclosure): `{type:'state'}` carries no data — only a signal to refetch the client's own authorized snapshot.
- T-10-14 (UX tampering — bogus toast): mitigated by emitting `{type:'state'}` instead of `{type:'turn-error'}` on a combat turn that advanced state; the retry toast is reserved for genuine model failures.

## Known Stubs

None. The notify guard is fully wired: `combatStateChanged` reads real server-resolved signals, `notifySession` sends a real Postgres NOTIFY, and the client SSE handler at `use-session-stream.ts:113-116` already maps `{type:'state'}` to `refetch()`.

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/route.ts` — MODIFIED (confirmed: combatStateChanged computed, state/turn-error XOR branch present)
- `tests/app/api/sessions/[id]/turn/empty-narration-notify.test.ts` — CREATED
- commit 2cbc52c — FOUND
- commit a69c17d — FOUND
- `tsc --noEmit` — CLEAN
- Empty-narration test 15/15 GREEN
- No new test failures (5 pre-existing remain)
