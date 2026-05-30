---
phase: 09
phase_slug: v2-monster-turns
status: planned
created: 2026-05-30
source: RESEARCH.md Validation Architecture
---

# Phase 09 Validation Strategy

> Derived from RESEARCH.md's Validation Architecture. Maps each phase requirement to its validation level and sampling rate (Nyquist principle: sample at 2x the highest-frequency failure mode).
>
> **Note:** ROADMAP maps no REQ-IDs to Phase 09 (`Requirements: TBD`). Coverage is therefore tracked against the 16 LOCKED decisions (D-01..D-16) in `09-CONTEXT.md`, which are this phase's de-facto requirements.

## Validation Levels

| Level | What it proves | When to use |
|-------|---------------|-------------|
| **Unit** | Logic correctness | Pure functions, algorithms, transformations |
| **Integration** | Component interaction | API calls, DB queries, service boundaries |
| **E2E** | User-facing behavior | Critical user flows, happy paths |
| **Manual** | Subjective quality | UX, visual design, content quality |

**Test framework:** Vitest (project standard — `vitest.config.ts` at root, 200+ existing tests). Run: `npx vitest run`.
Mirror the v1 pattern in `src/app/api/sessions/[id]/turn/__tests__/combat-resolver.test.ts` and the engine tests in `src/engine/combat/__tests__/`.

## Requirement → Validation Map

| Decision | Level | Test Approach | Sampling Rate |
|----------|-------|---------------|---------------|
| D-09 Hit rule (nat20 auto-hit / nat1 auto-miss / ≥AC) | Unit | Seeded RNG → assert hit/miss/no-crit-doubling at boundaries | Every boundary: AC-1, AC, AC+1, nat1, nat20 |
| D-10 Injectable RNG seam | Unit | Inject deterministic RNG → assert reproducible d20 + damage rolls | Core seam (resolver headless-testable) |
| D-11 Random live-PC target | Unit | Seeded RNG + multi-PC pool → deterministic pick, only HP>0 PCs | Live / dead / multi-PC |
| D-04 Bestiary prose parse (+N to hit, XdY±Z) | Unit | Feed real `## Actions` prose → assert extracted attack bonus + damage dice | 6 live bestiary files + malformed-prose edge |
| D-05 CR→(attackBonus, damageDice) table | Unit | Assert table lookups at floor/mid/high CR | CR 0, 1/4, 1, 5, 17 |
| D-06 Base default fallback (+4/1d6) | Unit | No `cr` + no bestiary match → assert +4 / 1d6 named constants | Default path |
| D-07 Bestiary path is non-blocking for the smoke | Unit | Custom-monster (D-05) path resolves with bestiary parse stubbed/absent | Isolation |
| D-01 Monster-turn trigger (active actor is a live monster) | Integration | Post-turn EncounterState w/ monster active → assert loop entry; PC active → no entry | Monster / PC / empty turnOrder |
| D-02 Server-side loop, same request | Integration | Multi-monster encounter → consecutive resolution in one request, single narration pass | 1 / 2 / N monsters |
| D-03 Stop conditions + safety cap | Unit | Assert stop on (a) live-PC active, (b) no live targetable PC, (c) safety cap | Each condition independently |
| D-12 PC-AC bridge | Integration | Extended party select → assert `ac` mapped per PC UUID (notNull, no default) | Single / multi PC |
| D-13 Damage via existing `hp_change` | Integration | Monster hit → assert `hp_change {character, delta:-dmg}` emitted, reducer clamps at 0 | Hit / kill / clamp-at-0 |
| D-14 PC at 0 HP → KO + stop if last PC | Unit | Last live PC drops to 0 → loop stops + party-KO signalled; non-last → loop continues | Last / not-last |
| D-08 Additive `cr?` schema, byte-stable replay | Unit | Old events (no `cr`) replay byte-identical; new events carry `cr` | Back-compat + new event |
| D-15 Single combined narration directive | Integration | N monster actions → exactly one narration directive listing every outcome | 1 / N actions |
| D-16 Directive suppression on server-resolved turn | Integration | Server-resolved monster turn → directive omits the "Area C — Turn rule" lines | Resolved / not-resolved |

## Sampling Rate

**Nyquist principle applied to the highest-frequency failure modes:**

- **Dice / hit-rule boundaries (highest frequency):** sample every boundary — nat1, nat20, AC-1, AC, AC+1 — per attack type. This is where off-by-one and crit-rule regressions hide. Seeded-RNG unit tests cover all five.
- **Loop termination (high severity):** sample all three stop conditions independently plus the safety cap. An unterminated loop is catastrophic (infinite HTTP request / hung Mac Mini M4 request), so each path gets a dedicated test.
- **Schema back-compat (high severity, low frequency):** sample old-event replay (no `cr`) and new-event replay (with `cr`) to prove byte-stable replay (D-08).
- **Narration consolidation (medium frequency):** sample 1 and N monster actions to prove the single-pass directive (D-15) — protects the M4 single-LLM-call latency constraint.

## Coverage Gaps

(none — all building blocks already ship in the repo)

Two state/schema **gaps the plan must close** before the resolver can be validated (from RESEARCH Pitfalls 1–2):

1. **PC current HP is not in `EncounterState`** (only monster HP is). The live-target filter (D-11) and last-PC-KO stop (D-14) need a `Map<pcId, hpCurrent>` sourced from `snap.party` / a targeted Postgres select — wired alongside the PC-AC map (D-12). Tests for D-11/D-14 depend on this seam existing.
2. **`cr?` from `monster_spawn` is not propagated into `EncounterState.monsters[]`** by the projector reducer. Both the `EncounterState` interface and `applyEncounterEvent` need the additive `cr?: number` field (additive → no existing-test breakage). The D-05/D-08 tests depend on `cr` being readable from encounter state.

## Notes

- All randomness (d20, damage, target selection) must draw from the **single injected RNG seam** (D-10) so every test above is deterministic. Default `src/engine/rand.ts` `defaultRng` (crypto-backed) in production; a seeded RNG in tests.
- No DB migration is required — `characters.ac` already exists (`notNull`); the only schema change is the additive Zod/event-type `cr?` field, which is in-app, not a database push.
- Bestiary-prose CR is a **string** in frontmatter (e.g. `"1/4"`) but `cr` in the event payload / EncounterState is **numeric** — normalize at the boundary (RESEARCH Pitfall 5).
