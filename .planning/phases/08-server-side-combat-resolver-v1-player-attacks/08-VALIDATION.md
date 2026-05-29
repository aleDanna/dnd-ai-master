---
phase: 08
slug: server-side-combat-resolver-v1-player-attacks
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-29
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `08-RESEARCH.md` § Validation Architecture (vitest; pure-helper +
> scripted-provider patterns; the route `POST` is a `waitUntil` background task and is
> NOT directly unit-tested — no-double-apply is verified at the loop layer).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.5 |
| **Config file** | `vitest.config.ts` (two projects: `components` jsdom @ `tests/components/**`; `node` @ `tests/**` excl. components/e2e) |
| **Quick run command** | `pnpm vitest run tests/app/api/sessions/\[id\]/turn/combat-resolver.test.ts` |
| **Full suite command** | `pnpm test` (alias for `vitest run`) |
| **Typecheck gate** | `pnpm tsc --noEmit` (every prior plan ran this clean — STATE.md) |
| **Estimated runtime** | quick: sub-second · full suite: a few seconds (~661 vault tests baseline) |

---

## Sampling Rate

- **After every task commit:** Run the targeted file `pnpm vitest run tests/app/api/sessions/\[id\]/turn/combat-resolver.test.ts` (sub-second; runs on every red/green).
- **After every plan wave:** Run the affected surface `pnpm vitest run tests/app/api tests/ai/master/vault tests/sessions` (resolver + loop + directive + interleaving).
- **Before `/gsd-verify-work`:** `pnpm test` (full suite) green + `pnpm tsc --noEmit` clean. Confirm the lone pre-existing `applicator/gp-stack` failure (noted in 07-03) is still the ONLY pre-existing failure.
- **Max feedback latency:** < 5 seconds for the quick command.

---

## Per-Task Verification Map

> Task IDs assigned at planning. Every row maps to REQ-039 (the sole phase requirement).
> `combat-resolver.test.ts` rows are pure-function (no mocks beyond an `EncounterState`
> fixture — copy the shape from `vault-combat-turn-interleaving.test.ts:59-68`).

| Task ID | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | 0 | REQ-039 | — | to-hit total ≥ AC → hit + damageRequest (with `per`) | unit | `pnpm vitest run -t "to-hit hit"` | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | to-hit total < AC → miss + `turn_advance`, damageRequest null | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | nat 20 < AC → still hit (auto-hit) | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | nat 1 ≥ AC → still miss (auto-miss) | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | `+0` bonus roll (no breakdown) → natural=total, parses correctly | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | damage roll → `monster_hp_change(id,-total)` + `turn_advance` | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | T (tampering) | target parsed from `danni a <name>` (case-insensitive EXACT) | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | DoS | unknown / ambiguous (>1) target → `null`; garbage string → `null`, no throw | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | default AC 12 when `monster.ac` absent; default die `1d6` in request | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | non-d20 + no `danni` keyword → `null`; 1d20 + no attack keyword → `null` | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 0 | REQ-039 | — | damage-request label round-trips with target via `parseRollRequests` (`per danni a` form) | unit | resolver test | ❌ W0 | ⬜ pending |
| TBD | 1 | REQ-039 | T (integrity) | narration-only mode DROPS LLM `monster_hp_change`/`turn_advance` calls (no double-apply) | integration | `pnpm vitest run tests/ai/master/vault/loop.test.ts` | ⚠ EXTEND | ⬜ pending |
| TBD | 1 | REQ-039 | — | non-resolution turn → loop dispatches `apply_event` normally (regression) | integration | loop test | ⚠ EXTEND | ⬜ pending |
| TBD | 1 | REQ-039 | — | D-07: resolve directive suppressed when server resolved | unit | `pnpm vitest run tests/ai/master/vault/turn-directive.test.ts` | ⚠ EXTEND | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` — NEW; covers all REQ-039 resolver-math unit rows above. Pure function; `EncounterState` fixture copied from `vault-combat-turn-interleaving.test.ts:59-68`.
- [ ] `tests/ai/master/vault/loop.test.ts` — EXTEND with a narration-only-mode describe block. Reuse the existing `scriptedProvider` + `vi.mock('@/db/client')` harness (`loop.test.ts:19-89`); script a response that emits `apply_event monster_hp_change` and assert it is NOT dispatched (no persist) when the flag is set.
- [ ] `tests/ai/master/vault/turn-directive.test.ts` — EXTEND for D-07 suppression.
- [ ] Framework install: **none** — vitest already present; no `npm install` task.

*No-double-apply is verified at the loop layer (not a full route test): the route `POST` is a `waitUntil` background task with heavy auth/DB coupling and is not directly unit-tested in this repo.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator smoke: end-to-end player attack on a live campaign | REQ-039 | Needs a live local LLM (model narration obedience + full client UX) — the two automated layers run headless with a scripted provider | On One Piece (qwen3), combat active: attack Veyra → server confirms hit/miss vs AC (no arbitrary outcome) → on hit the 🎲 damage button appears → roll damage → Veyra's HP drops in the CombatTracker → turn advances; narration matches the server outcome with no contradiction. (`scripts/_probe-combat.ts` `resolve` mode simulates the exact roll-result string format.) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
