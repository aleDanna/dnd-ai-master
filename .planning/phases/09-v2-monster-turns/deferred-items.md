# Phase 09 — Deferred Items

Out-of-scope discoveries logged during execution (not fixed — outside the touching plan's scope).

## Pre-existing test failures (discovered during 09-02 full-suite run, 2026-05-30)

These 4 tests fail on the full `npx vitest run` but are unrelated to v2 monster turns and were NOT introduced by Phase 09 work. The 09-02 commits (`b1c9fbc`, `b06b6c5`) add only `monster-turns.ts` + its test (verified: no deletions, no edits to any other file). Logged here per the executor scope-boundary rule; do NOT fix as part of Phase 09 combat plans.

| Test file | Failing case | Notes |
|-----------|--------------|-------|
| `tests/sessions/applicator.test.ts` | `applyMutations > add_inventory + remove_inventory + set_equipped` (gp-stack qty 60 vs 50) | Inventory, last touched by `7ad8533` (pre-Phase-08). Already logged in `08/deferred-items.md`. |
| `tests/api/scene-image-coalesce.test.ts` | `coalesces concurrent calls > only calls the image provider once` | Concurrency/provider-coalescing — environment-sensitive, not combat. |
| `tests/api/tts-coalesce.test.ts` | `coalesces concurrent calls > only calls the provider once` | Concurrency/provider-coalescing — environment-sensitive, not combat. |
| `tests/lib/preferences-local-validation.test.ts` | `local provider gating > rejects aiProvider=local when not local environment` | Env-gating test — depends on environment detection, not combat. |

## Operator smoke 2026-05-31 — v2 loop NOT exercised + 2 findings

The 09-06 operator smoke (One Piece campaign, custom monster "Freya") did NOT trigger the
v2 monster-turn loop, so v2's end-to-end behavior remains UNVERIFIED by live play. The
automated evidence stands (507 combat/vault tests green, `tsc --noEmit` clean, route.ts
wiring spot-checked: `runMonsterTurnLoop` call, `monsterResolved` directive, PC-AC/PC-HP
maps, `(_resolver !== null || _monsterLoopRan)` suppress gate, `enforceResolvedNarration`
bound whenever the loop ran).

**Why the loop never ran (root cause, evidence-backed):** the player attacked with FREE
TEXT ("io provo ad attaccarla con un gum gum gatling"). The server combat resolver only
engages on a roll-result (`isRollResult()` requires `🎲` / "I rolled" — `turn-directive.ts:95`),
so `_resolver` stayed null (`route.ts:380`); the local model free-narrated (dev.log:
`tool_calls=0`), emitted NO `turn_advance`, so the active actor never advanced to the
monster, so `runMonsterTurnLoop` was never invoked (`route.ts:454`). Confirmed against the
live `events.md` (29 events): zero monster→PC `hp_change` anywhere — the v2 path has never
executed on this campaign.

**To actually verify v2:** redo the smoke clicking the 🎲 roll chip when the master asks
for the roll (that roll-result fires the v1 resolver → emits `turn_advance` → active actor
becomes the monster → v2 loop runs), OR drive it from a headless integration test that
seeds an events.md where a monster is the active actor and asserts the route emits monster
`hp_change` + `turn_advance` + a single combined narration.

### Finding 1 — combat tracker stale on dropped SSE `message` (PRE-EXISTING, spun off)
During vault combat, if the SSE `message` event is dropped, the game-client safety nets
(`startSafetyPoll` / `finalizedSeq` effect → `fetchSessionData`) refetch ONLY
`/messages` + `/character`, NOT the session snapshot (`GET /api/sessions/:id`) that carries
combat state — so the tracker (turn pointer + HP) goes stale until another SSE event calls
`useSessionStream.refetch()`. The vault path never emits the `state` SSE event (only
`applicator.ts` does, on the Postgres path), so on vault `message` is the only tracker-refresh
trigger. Orthogonal to Phase 09; spun off to its own session/worktree for a TDD fix.

### Finding 2 — free-text attacks aren't mechanically resolved (v1-level, larger than Phase 09)
With a local model, an attack typed as free text isn't reliably turned into a roll-request,
so no server resolution happens and the turn stalls (no dice, no damage, no advance). This is
a v1/prompt-reliability gap (Phase 08 territory), not a v2 monster-turn bug. Deferred — likely
needs a dedicated phase or a `/gsd-debug` session. The Attack quick-button currently inserts
free text ("I attack with my equipped weapon." — `narrative-pane.tsx:245`) rather than opening
a roll, which is why the smoke naturally hit this path.
