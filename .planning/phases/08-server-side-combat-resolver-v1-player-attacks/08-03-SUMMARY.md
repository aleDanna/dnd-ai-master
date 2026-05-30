---
phase: 08-server-side-combat-resolver-v1-player-attacks
plan: 03
subsystem: api
tags: [combat, vault, turn-route, resolver-wiring, enforce-narration, lifecycle, operator-smoke, REQ-039]

# Dependency graph
requires:
  - phase: 08-server-side-combat-resolver-v1-player-attacks (plan 01)
    provides: pure resolveCombat + parsing helpers (the server-side outcome the route emits)
  - phase: 08-server-side-combat-resolver-v1-player-attacks (plan 02)
    provides: suppressCombatMutations loop flag + serverResolved directive suppression (no double-apply)
  - phase: 07-vault-combat-playable-d2
    provides: vault turn route, runVaultToolLoop, buildTurnDirective/isRollResult, 07-03 resolveCombatHandoff
provides:
  - "Vault-branch wiring: early encounter read → D-01 gate → resolveCombat → server-side emit via dispatchVaultTool → narration-only loop + resolver directive → authoritative narration enforcement → 07-03 handoff preserved"
  - "enforceResolvedNarration: makes the resolver AUTHORITATIVE over the mechanical channel (strips the model's competing roll-requests + leaked apply_event JSON-as-text; enforces the resolver's damage request)"
  - "Resolver robustness: duplicate-name target disambiguation via turnOrder+isAlive; fall-through observability log"
  - "Combat-lifecycle hardening: turn_advance skips dead monster actors (no stall); monster_spawn resets an all-dead active encounter (clean new fight)"
  - "REQ-039 verified END-TO-END live (operator smoke): player attack → server hit/miss vs AC → damage applied (Freya 45→36) → turn advanced → LLM narrated"
affects: [v2 monster turns — the next phase; needs the PC-AC Postgres bridge]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server-authoritative mechanical channel: on a resolution turn the route strips the local model's freelanced roll-requests + tool-call-as-text and injects the resolver's deterministic request — the model only colors (narration)"
    - "Stale/orphan-spawn resilience: name-collision targets disambiguate to the live combat participant; turn handoff skips dead actors; new fights reset all-dead encounters — so unreliable-LLM lifecycle mistakes degrade gracefully instead of stalling"

key-files:
  created: []
  modified:
    - src/app/api/sessions/[id]/turn/route.ts (vault-branch resolver hook: early read, gate, emit, narration-only loop, enforceResolvedNarration)
    - src/app/api/sessions/[id]/turn/combat-resolver.ts (matchMonster turnOrder disambiguation; enforceResolvedNarration helper; narration directives tightened)
    - tests/app/api/sessions/[id]/turn/combat-resolver.test.ts (disambiguation + enforce tests)
    - src/ai/master/vault/projector.ts (turn_advance skip-dead; monster_spawn all-dead reset)
    - tests/ai/master/vault/combat-reducer.test.ts (lifecycle hardening tests)

---

## Performance

Route wiring landed in one task; the operator smoke then surfaced four bugs that each
required diagnosis (events.md/DB inspection + headless repros) and a targeted fix. Total
~6 fix commits across the plan + the smoke-driven gap closure.

## Accomplishments

- Wired `resolveCombat` into the vault branch of `route.ts` (Task 2): early encounter read, the D-01 gate on the clean `_playerMessage`, server-side emit via `dispatchVaultTool`, `suppressCombatMutations:true` narration-only loop with the resolver's directive, and the 07-03 post-loop handoff preserved.
- **REQ-039 verified END-TO-END live** (Task 4 operator smoke, One Piece / qwen3): a player attack on Freya was resolved server-side (hit vs AC), the `Tira 1d6+3 per danni a Freya` button appeared, the roll applied **−9 HP (Freya 45→36)**, and the turn advanced — confirmed in `events.md` (`monster_hp_change{freya,-9}` + `turn_advance`) and `combat.md` (`currentIdx 1`).

## Task Commits

- Task 1 (read gate, human-action) — no code change; operator confirmed the Next.js 16 route-handler guide read (POST signature unchanged, `params` Promise already handled).
- Task 2 (route wiring) — `0906cac` `feat(08-03)` route.ts vault-branch resolver hook (+128/−5).
- Task 3 (regression) — verification-only; affected surface + full suite green (only the pre-existing `applicator/gp-stack` failure).
- Task 4 (operator smoke, human-verify) — APPROVED after the smoke-driven gap fixes below.

### Smoke-driven gap fixes (Task 4)
- `1d312d6` `test(08)` RED tests for duplicate-name target disambiguation.
- `4f17c7a` `fix(08)` resolver disambiguates duplicate-name targets via turnOrder; log fall-through.
- `3f80993` `fix(08)` enforce resolver authority on resolution turns — strip competing LLM roll-requests + leaked event-JSON.
- `e6443b1` `fix(08)` combat-lifecycle hardening — turn_advance skips dead actors; spawn resets all-dead encounter.

## Files Created/Modified

See `key-files` above. Net new code: the `enforceResolvedNarration` helper + the route hook; reducer deltas in `turn_advance`/`monster_spawn`; `matchMonster` collision disambiguation.

## Decisions Made

- The resolver is **authoritative** over the mechanical channel on resolution turns (strip + enforce), not merely a "safety-net append" — the local model competes and the append-if-missing logic deferred to its malformed request.
- Name-collision targets resolve to the live `turnOrder` participant (preserves T-08-01: still null if >1 live match).
- `turn_advance` skips dead monster actors; `monster_spawn` resets an all-dead active encounter — so the unreliable LLM lifecycle (skipped `combat_start`, duplicate/stale spawns, dead actors in the order) degrades gracefully instead of stalling.

## Deviations from Plan

The Task-4 operator smoke revealed that the plan's design, while correct, was insufficient
against live qwen3 behavior. Four root causes were diagnosed and fixed (commits above):
1. Two monsters shared the name "Veyra" (LLM dup-spawn) → ambiguous match → resolver inert.
2. The model emitted its OWN `2d6 danni` request that the append-if-missing safety-net deferred to → resolver request suppressed.
3. The turn stalled on a dead monster left in the turnOrder; encounters never reset (LLM emits `combat_end` as text).
4. (Infra, out of scope) qwen3 intermittently HANGS on the LLM action turns — diagnosed as a model/Ollama reliability issue, not the resolver. Mitigated operationally (model restart / lighter model).

## Issues Encountered

- `combat.md` line refs in CONTEXT had drifted; verified against the live 936-line route.
- The dirty live encounter (accumulated dup/dead Veyras) was reset via an emitted `combat_end` to unstick the operator.

## User Setup Required

- Restart `pnpm dev` (+ `rm -rf .next`) after pulling — `route.ts` and `projector.ts` (deeply imported) changed.
- qwen3:30b can hang on full combat ACTION turns on dev hardware; a lighter master model is more reliable for narration (the resolver does the math deterministically regardless).

## Next Phase Readiness

v1 (player attacks) is complete + verified live. The observed "the monster doesn't attack" is
**v2 monster turns** — explicitly deferred by the spec (needs the PC's AC from Postgres + monster
attack data). The resolver, narration-only mode, lifecycle hardening, and the authoritative-
narration enforcement are all in place for v2 to build on.

## Self-Check: PASSED

- `pnpm tsc --noEmit` clean.
- Resolver unit suite (24), reducer suite (33), loop/directive/turn-interleaving all green; full-suite regression 956 passed (only the pre-existing `applicator/gp-stack` failure).
- REQ-039 verified end-to-end in the live operator smoke (Freya −9, turn advanced).

---
