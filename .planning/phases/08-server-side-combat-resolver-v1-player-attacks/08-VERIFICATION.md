---
phase: 08-server-side-combat-resolver-v1-player-attacks
verified: 2026-05-30T15:24:48Z
status: passed
score: 16/16 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  note: initial verification
---

# Phase 08: Server-Side Combat Resolver (v1 Player Attacks) Verification Report

**Phase Goal:** Move combat MECHANICAL RESOLUTION server-side — when a roll-result arrives during an active vault encounter, the turn route resolves deterministically (roll → AC → hit/miss → damage → `monster_hp_change` → `turn_advance`) reusing the engine math, and the LLM only NARRATES. v1 scope = PLAYER attacks. Success: a player attack roll is resolved server-side (model no longer decides the outcome); on a hit, damage applies via `monster_hp_change` and the monster's HP drops in the CombatTracker; the turn advances; the LLM narrates the server-determined outcome with no contradiction.
**Verified:** 2026-05-30T15:24:48Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Must-haves are the merge of the 4 ROADMAP success criteria (the contract) + the per-plan
frontmatter truths. ROADMAP `success_criteria` JSON array was empty; the 4 criteria were
extracted from the ROADMAP prose `## Phase 08` section (the canonical contract).

#### ROADMAP contract (4 success criteria)

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | A player attack roll during combat is resolved server-side (hit/miss vs monster AC) — the model no longer decides the outcome | VERIFIED | `resolveCombat` (combat-resolver.ts:148) mirrors the engine hit rule on the rolled total (`hit = natural !== 1 && (natural === 20 || total >= ac)`, :180). Wired into route.ts BEFORE `runVaultToolLoop` (gate :378, resolve :385). The LLM turn runs narration-only (`suppressCombatMutations:true`, route.ts:505) + directive suppression (`serverResolved`, route.ts:447) so the model cannot decide/apply the outcome. Independent probe confirmed HIT(18 vs AC14) and MISS(8 vs AC14). |
| R2 | On a hit, damage is applied via `monster_hp_change` and the monster's HP drops in the CombatTracker | VERIFIED | Damage branch emits `monster_hp_change{id,delta:-total}` (combat-resolver.ts:213); route emits it server-side via `dispatchVaultTool('apply_event', ev, {campaignId})` (route.ts:417); reducer applies `hpCurrent = max(0, hp+delta)` + recomputes `isAlive` (projector.ts:812-813), which regenerates combat.md. Operator smoke (Task 4, APPROVED): Freya 45→36 (−9) recorded live in events.md + combat.md. Independent probe reproduced `monster_hp_change{freya-id,-9}`. |
| R3 | The turn advances (`turn_advance`) after the player's action resolves | VERIFIED | MISS emits `turn_advance` (combat-resolver.ts:185); DAMAGE emits `monster_hp_change` THEN `turn_advance` (:214). Reducer advances `currentIdx` skipping dead actors (projector.ts:775-803). 07-03 `resolveCombatHandoff` re-reads post-`turn_advance` state and hands to next PC (route.ts:582, preserved). Smoke: `combat.md currentIdx 1` after the resolve. |
| R4 | The LLM narrates the server-determined outcome (no contradiction between narration and mechanics) | VERIFIED | `serverResolved` directive injects `resolver.narrationDirective` (`[RESOLVED BY SYSTEM: …] narra in 2ª persona`) into history (route.ts:467-472); `enforceResolvedNarration` makes the resolver AUTHORITATIVE — strips the model's competing roll-requests + leaked event-JSON and appends the resolver's request (route.ts:546; helper combat-resolver.ts:252). Probe confirmed strip+append+flavor-preservation. Operator smoke (human-APPROVED): narration matched mechanics, no contradiction. |

#### Plan 08-01 frontmatter truths (resolver math)

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| 1  | total >= AC → HIT + damage-request | VERIFIED | combat-resolver.ts:194-199; resolver test (24 cases) green; probe green |
| 2  | total < AC → MISS, emits turn_advance, no damage-request | VERIFIED | combat-resolver.ts:182-189; tests green; probe green |
| 3  | nat-20 below AC HITS; nat-1 at/above AC MISSES | VERIFIED | combat-resolver.ts:180 (`natural !== 1 && (natural === 20 || …)`); resolver test covers both rows |
| 4  | damage roll emits monster_hp_change(id,-total) then turn_advance | VERIFIED | combat-resolver.ts:212-215; probe asserted exact event array `[hp_change{-9}, turn_advance]` |
| 5  | unknown/ambiguous/non-combat/unparseable → null (never throws) | VERIFIED | All 9 `return null` paths gated (combat-resolver.ts); `matchMonster` 0/>1 → null (:124-132); probe `not.toThrow()` green |
| 6  | damage-request round-trips through client parser carrying target (`per danni a` form) | VERIFIED | combat-resolver.ts:198 `Tira ${die}+${bonus} per danni a ${name}`; resolver test asserts `parseRollRequests` round-trip; probe `/per danni a Freya/` green |

#### Plan 08-02 frontmatter truths (no-double-apply guards)

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| 7  | narration-only mode DROPS the LLM's combat-event apply_event calls (no double-apply) | VERIFIED | loop.ts:338-358 drop branch gated on `suppressCombatMutations && apply_event && ENCOUNTER_EVENT_TYPES.has(type)`; loop.test.ts case (a) green (zero new lines) |
| 8  | non-combat apply_event STILL dispatches under the flag | VERIFIED | loop.ts:341 scopes drop to ENCOUNTER_EVENT_TYPES only; loop.test.ts case (c) (hp_change still dispatched) green |
| 9  | flag-off: encounter-event apply_event dispatches as Phase 07 (regression) | VERIFIED | loop.ts:339 (flag falsy → falls to dispatcher :365); loop.test.ts case (b) green |
| 10 | serverResolved suppresses the player-side resolve directive | VERIFIED | turn-directive.ts:118 (`!serverResolved && isRollResult`); also gates combat-intent :145 + general catalog :179; directive tests green |
| 11 | without serverResolved, resolve directive still emitted (regression) | VERIFIED | turn-directive.ts:118 gating; regression test (flag-absent emits) green |

#### Plan 08-03 frontmatter truths (route wiring)

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| 12 | on a roll-result during active encounter, route resolves server-side BEFORE the loop and emits resolver events | VERIFIED | route.ts:377-422 (gated early read → resolveCombat → emit loop) — strictly before `runVaultToolLoop` at :479 |
| 13 | narration-only loop runs with resolver directive; LLM combat-event calls dropped | VERIFIED | route.ts:467-472 (inject narrationDirective) + :505 (`suppressCombatMutations:true`) |
| 14 | on a hit the damage-request button reliably appears (enforced, supersedes safety-net) | VERIFIED | route.ts:546 `enforceResolvedNarration` strips competing requests + appends the resolver's authoritative one; persisted as `_finalNarration` (:629); probe confirmed |
| 15 | 07-03 post-loop handoff still runs and re-reads post-turn_advance encounter | VERIFIED | route.ts:580-582 (`resolveCombatHandoff` on re-read encounter) — present, not deleted |
| 16 | non-combat turns + unparseable rolls run EXACTLY as Phase 07 (gate does not fire) | VERIFIED | Gate `vaultMutationsEnabled && isRollResult && encounter.active` (route.ts:378,381); `resolver===null` falls through (:386); all `_resolver !== null` branches no-op when null. Affected-surface suite (962 passed) incl. turn-interleaving / handoff regression green |

**Score:** 16/16 truths verified (4 ROADMAP criteria + 12 plan truths; deduplicated — plan truths 1-5/12-13 detail R1-R3, 14 details R2/R4).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/app/api/sessions/[id]/turn/combat-resolver.ts` | Pure resolveCombat + helpers + enforceResolvedNarration | VERIFIED | 277 lines, exports `resolveCombat`, `ResolveCombatResult`, `enforceResolvedNarration`. Pure (no Date.now/Math.random/randomUUID/process.env/fs). Imported + called by route.ts. |
| `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` | Headless REQ-039 suite | VERIFIED | 24 cases, ran live → 24/24 passed |
| `src/ai/master/vault/loop.ts` | suppressCombatMutations + ENCOUNTER_EVENT_TYPES drop branch | VERIFIED | Flag :83, import :15, drop branch :338-358; wired from route.ts:505 |
| `src/ai/master/vault/turn-directive.ts` | serverResolved opt suppressing re-ask directives | VERIFIED | Flag :54, gates 3 branches (:118/:145/:179); wired from route.ts:447 |
| `src/ai/master/vault/projector.ts` | turn_advance skip-dead + monster_spawn all-dead reset + hp clamp | VERIFIED | skip-dead :775-803, all-dead reset :741-746, hp clamp :812-813 |
| `src/app/api/sessions/[id]/turn/route.ts` | Vault-branch resolver hook | VERIFIED | Full wiring :360-547; 07-03 handoff preserved :582 |
| `tests/ai/master/vault/combat-reducer.test.ts` | Lifecycle hardening tests | VERIFIED | 33 cases, ran live → green (within the 97-pass run) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| route.ts | combat-resolver.ts | `import { resolveCombat, enforceResolvedNarration }` + call | WIRED | route.ts:37 import; :385 call; :546 enforce |
| route.ts | tools.ts | `dispatchVaultTool('apply_event', ev, {campaignId})` per event | WIRED | route.ts:28 import; :417 emit loop over `_resolver.events` |
| route.ts | loop.ts | `runVaultToolLoop(... suppressCombatMutations:true)` on resolution turns | WIRED | route.ts:505 |
| route.ts | turn-directive.ts | `buildTurnDirective(... serverResolved)` + `appendDirectiveToHistory` + `isRollResult` gate | WIRED | route.ts:40 import; :447 serverResolved; :378 gate; :453/468 inject |
| loop.ts | events-schema.ts | `import ENCOUNTER_EVENT_TYPES` to scope the drop | WIRED | loop.ts:15; set contains turn_advance + monster_hp_change (events-schema.ts:336-337) |
| combat-resolver.ts | events-schema.ts | `import type VaultEvent` — plain {type,payload} | WIRED | combat-resolver.ts:30 |
| resolver→reducer (data flow) | projector.ts | emitted `monster_hp_change` delta → `max(0, hp+delta)` | WIRED | resolver emits delta only (:213); reducer clamps (:812) — round-trip proven by smoke (Freya 45→36) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| route.ts vault branch | `_resolver` | `resolveCombat({rollResult: _playerMessage, encounter})` where encounter = `replayEvents(parseEventsFile(eventsPath(campaign.id)))` | Yes — real events.md replay → real EncounterState | FLOWING |
| route.ts emit | `_resolver.events` | dispatched via `dispatchVaultTool` → EventsWriter → events.md → combat.md regen | Yes — persisted (smoke confirmed events.md + combat.md mutated) | FLOWING |
| route.ts persistence | `_finalNarration` | `enforceResolvedNarration(vaultResult.finalText, _resolver)` → inserted into sessionMessages (:629) + addressee (:608) | Yes — used for both persistence and handoff | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Resolver unit suite | `pnpm vitest run …/combat-resolver.test.ts` | 24 passed | PASS |
| No-double-apply guards + reducer | `pnpm vitest run loop.test.ts turn-directive.test.ts combat-reducer.test.ts` | 97 passed | PASS |
| Affected-surface (plan gate) | `pnpm vitest run tests/app/api tests/ai/master/vault tests/sessions` | 962 passed, 1 pre-existing fail, 47 skipped | PASS (the 1 fail is the documented `applicator/gp-stack` pre-existing failure — see Anti-Patterns) |
| Typecheck | `pnpm tsc --noEmit` | exit 0 | PASS |
| Independent verifier probe (written from scratch, Freya scenario) | ephemeral vitest: to-hit HIT/MISS, damage→hp_change(-9)+turn_advance, enforceResolvedNarration strip+append, garbage→null | 5 passed | PASS |

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| `scripts/_probe-combat.ts` (`resolve` mode) | `tsx scripts/_probe-combat.ts resolve` | NOT RUN — requires a LIVE local LLM (qwen3 via `getProviderByName('local')`) + live Postgres (`db.execute`). Non-deterministic, not a `scripts/*/tests/probe-*.sh` probe. Routed to human verification (already covered by Task 4 operator smoke, APPROVED). | SKIP (live-LLM/DB; covered by human-verify Task 4) |
| Independent resolver chain probe | ephemeral vitest (verifier-authored) | 5/5 passed (Freya −9 chain reproduced) | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| REQ-039 | 08-01, 08-02, 08-03 (all declare `requirements: [REQ-039]`) | Vault-path combat resolution is DETERMINISTIC / server-side: roll → kind+target → to-hit vs AC → hit/miss → damage → monster_hp_change → turn_advance, reusing engine math; LLM only narrates. v1 = player attacks. | SATISFIED | All 16 truths VERIFIED; resolver mirrors `attack.ts` hit rule on the rolled total; server emits authoritative events; LLM narration-only + enforced. Operator smoke verified end-to-end live (Freya). No orphaned requirements: REQUIREMENTS.md maps no additional IDs to Phase 08, and Phase 08 is the last phase in ROADMAP. |

Note on the requirement wording "reusing engine math (`makeAttack`/`applyDamage`/`dice`)": the resolver
intentionally MIRRORS the engine hit rule (`attack.ts:345/361/365`) on the already-rolled total rather
than CALLING `makeAttack`/`applyDamage` — because those re-roll the d20 and need a full Character /
resistance model the vault path lacks (decision D-09, documented in 08-01-SUMMARY and the resolver
JSDoc). This is a faithful reuse of the same deterministic hit rule, not a divergence; the rolled
total already carries the PC's bonus (the v1 simplification). SATISFIED.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all modified source files) | — | TBD/FIXME/XXX debt markers | None | Scanned combat-resolver.ts, route.ts, loop.ts, turn-directive.ts, projector.ts — ZERO debt markers |
| (all modified source files) | — | TODO/HACK/PLACEHOLDER | None | Zero warning-level markers |
| combat-resolver.ts | 9× `return null` | empty-return | ℹ️ Info (by design) | The never-throw fall-through contract (D-05/D-10) — every `return null` is a gated, intentional fall-through to the normal LLM turn, exercised by passing unit tests + the probe. NOT a stub. |
| tests/sessions/applicator.test.ts | 105 | failing test (gp qty 60 vs 50) | ℹ️ Info (pre-existing, out of scope) | The documented `applicator/gp-stack` failure. Confirmed pre-existing: last commit touching `applicator.test.ts` AND `src/sessions/applicator.ts` is `7ad8533` (2026-05-15, BEFORE Phase 08); NO Phase 08 commit touched either file. Logged in `deferred-items.md`; explicitly excluded by all 3 plans' verification sections. Inventory/equipment surface — unrelated to the combat resolver. NOT a Phase 08 regression. |

### Human Verification Required

None outstanding. The single item that requires a live local LLM — the model-narration-obedience +
full client UX end-to-end smoke — was the phase's own `checkpoint:human-verify` Task 4 (08-03), which
the operator ran on the One Piece campaign (qwen3) and **APPROVED** (resume-signal "approved"): a player
attack on Freya resolved server-side (hit vs AC), the `Tira 1d6+3 per danni a Freya` button appeared, the
roll applied −9 HP (Freya 45→36), and the turn advanced — recorded in the live campaign's events.md
(`monster_hp_change{freya,-9}` + `turn_advance`) and combat.md (`currentIdx 1`). That smoke surfaced 4
bugs which were diagnosed + fixed with unit tests (duplicate-name disambiguation `4f17c7a`; resolver
authority `3f80993`; combat-lifecycle hardening `e6443b1`). This live verification is recorded in
08-03-SUMMARY and is not re-runnable in a headless verifier environment by design.

### Scope Boundary (deferred by design — NOT gaps)

These are EXPLICITLY out of v1 scope per the phase goal + ROADMAP "Decomposition" (line 223) and are
NOT flagged as gaps:
- **MONSTER turns** (a monster attacking the PC) → v2 (needs the PC's AC from Postgres + monster attack data).
- **Real weapon dice, crit doubling, resistances, auto `combat_end`** → v3 polish.

Phase 08 is the LAST phase formally defined in the ROADMAP; v2/v3 are documented future decomposition
but not yet broken into phases, so there is no later-phase mapping to defer against — the deferral is
inherent to the v1 phase goal. No Step 9b deferred-items entries are needed.

### Gaps Summary

No gaps. Every must-have (16/16) is VERIFIED with codebase evidence:
- The resolver is pure, substantive (277 lines), and unit-green (24/24 — run live, not trusted from SUMMARY).
- The no-double-apply guards (loop drop + directive suppression) are wired and unit-green (97/97).
- The route hook is correctly ordered (gated early read → server-side emit BEFORE the loop →
  narration-only loop with the resolver directive → enforceResolvedNarration → 07-03 handoff preserved),
  and the non-combat path is regression-clean (affected-surface 962 passed; the lone failure is the
  documented pre-existing `applicator/gp-stack`, untouched by Phase 08).
- Typecheck is clean.
- An independent verifier-authored behavioral probe reproduced the exact live-smoke Freya chain
  (HIT → `per danni a Freya` → damage → `monster_hp_change{-9}` + `turn_advance` → strip/enforce).
- REQ-039 is fully accounted for (declared in all 3 plans; satisfied; no orphans).
- The operator smoke (Task 4) verified the live model-narration obedience end-to-end and was APPROVED.

The deviations from the literal plans (resolver became AUTHORITATIVE via `enforceResolvedNarration`
instead of the planned `parseRollRequests` "safety-net append"; D-07 broadened to suppress all 3 re-ask
directives; added `matchMonster` disambiguation + combat-lifecycle hardening) are documented in the
SUMMARYs as smoke-driven correctness fixes that STRENGTHEN the must-haves (they make the integrity
control hold against real qwen3 behavior). They do not reduce scope and each is backed by unit tests.
Phase goal achieved.

---

_Verified: 2026-05-30T15:24:48Z_
_Verifier: Claude (gsd-verifier)_
