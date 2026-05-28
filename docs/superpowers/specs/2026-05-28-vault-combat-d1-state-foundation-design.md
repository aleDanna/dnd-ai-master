# Design — Vault Combat D1: State Foundation (event-sourced, headless)

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — ready for implementation plan
**Type:** Production feature (vault path game-mechanics, piece D — sub-phase D1 of 3).

## Purpose

The vault-path Dungeon Master has no combat: the vault snapshot hard-codes
`inCombat: false, combat: null` and never tracks monster actors, so the existing
`CombatTracker` UI is permanently empty on vault campaigns. This is **piece D**
of the "game-mechanics on the vault path" effort (A: anti-railroading — Phase 04;
B: manual rolls — Phase 05; **D: combat**). The operator's report ("non entro mai
in combattimento") is the driver.

Architecture decision (brainstorming): **vault-native event-sourced combat** —
combat state lives in `events.md` (replayable, Postgres-free, honoring REQ-004 /
REQ-007), NOT bridged to the Postgres combat engine. Piece D is decomposed
**infra-first** into three sub-phases:

- **D1 (this spec):** the combat **state foundation** — encounter-scoped event
  types + projector reducer + `combat.md` materialized view + snapshot wiring so
  the (already backend-agnostic) `CombatTracker` renders vault combat state.
  Fully **headless-testable**: events are applied by tests, not the LLM.
- **D2 (later):** LLM-driven combat — tool/dispatcher exposure, the "Combat
  lifecycle" prompt block, the bestiary (`handbook/monsters/<slug>.md`), and
  PC↔monster turn interleaving. "Combat works" after D2.
- **D3 (later, optional):** action-economy depth (action/bonus/reaction/movement,
  positions) + in-combat conditions polish.

D1 proves the state→view→UI pipeline in isolation before the flaky local LLM is
put in the loop.

## Scope decisions (from brainstorming)

- **Vault-native (option B), not a Postgres bridge.** No writes to
  `session_state.combat` / `combat_actors`. Combat state is event-sourced in
  `events.md` and replayable.
- **Single append-only log.** New encounter-scoped event types go into the
  existing `events.md` / `events-schema.ts`, not a separate combat log. The
  per-PC "character UUID required" guard is relaxed for encounter events.
- **Fat, self-contained `monster_spawn` events.** The spawn event carries a
  deterministic `id` (assigned by the spawner, *in the payload* → deterministic
  replay) AND the full stat block. Replay never depends on mutable external files
  (event-sourcing immutability). The *source* of those stats (bestiary markdown)
  is D2; in D1 the test supplies them.
- **PC HP is reused, not duplicated.** The encounter references PCs by UUID in
  `turnOrder`; their HP stays in the existing per-character views. Only monsters
  live in the encounter state.
- **Reuse `CombatTracker` as-is.** It is already backend-agnostic
  (`Pick<SessionStateRow,'inCombat'|'combat'>` + `CombatActorRow[]`); D1 only
  feeds it the right shape from the vault.
- **No action economy in D1.** `turnState` / `position` / movement / budgets are
  D3. The D1 actor shape is the minimal renderable subset.
- **No LLM surface in D1.** No prompt block, no `apply_event` tool exposure for
  combat events, no bestiary content, no turn interleaving driving the master —
  all D2. D1 events flow via `EventsWriter` / the projector, exercised by tests.

## Architecture

Extend the vault event-sourcing pipeline with an **encounter lane** parallel to
the existing per-character lane:

```
combat events in events.md
  → validateEvent (events-schema.ts)            [accepts encounter events]
  → EventsWriter.applyEvent → regenerateAffectedViews  [writes combat.md]
  → replayEvents (projector.ts) builds, alongside Map<charId,CharacterState>,
    an EncounterState                            [new reducer]
  → serialize EncounterState → combat.md frontmatter (a materialized view)
  → snapshot-reader.ts / client-snapshot.ts surface { combat, actors }
  → CombatTracker renders (unchanged)
```

The per-character projector is untouched in behavior; the encounter reducer is
additive.

## Event schema (LOCKED — 6 encounter-scoped types)

All are encounter-scoped (no `payload.character`). Exact `type` strings and
payload shapes:

| type | payload | reducer effect |
|---|---|---|
| `combat_start` | `{}` | begin encounter: `active=true, round=1, currentIdx=0, turnOrder=[], monsters=[]` |
| `monster_spawn` | `{ id: string, name: string, hpMax: number, ac?: number, initiativeBonus?: number }` | append a monster actor `{ id, name, hpMax, hpCurrent: hpMax, ac, initiativeBonus, isAlive: true, conditions: [] }` |
| `initiative_set` | `{ order: Array<{ actorId: string, initiative: number }> }` | set `turnOrder = order` (caller-supplied order — PC UUIDs + monster ids), `currentIdx=0` |
| `turn_advance` | `{}` | `currentIdx++`; if past end → `currentIdx=0, round++` |
| `monster_hp_change` | `{ id: string, delta: number }` | `hpCurrent += delta` (clamp ≥ 0); `isAlive = hpCurrent > 0` |
| `combat_end` | `{}` | `active=false` (encounter cleared from the live view) |

`id` for monsters is a caller-assigned string in the `monster_spawn` payload
(e.g. `"goblin-1"`); it MUST be stable across replay. `monster_hp_change`,
`initiative_set`, and `turn_advance` reference monsters by that id and PCs by
their party UUID.

## EncounterState + `combat.md` view

Reducer output:

```
EncounterState = {
  active: boolean,
  round: number,
  currentIdx: number,
  turnOrder: Array<{ actorId: string, initiative: number }>,
  monsters: Array<{ id: string, name: string, hpCurrent: number, hpMax: number,
                    ac?: number, initiativeBonus?: number,
                    isAlive: boolean, conditions: string[] }>,
}
```

`combat.md` materializes this (frontmatter). When `active === false` (no
`combat_start`, or after `combat_end`), the view represents "no encounter".

**Snapshot mapping → CombatTracker:**
- `state.inCombat` = `encounter.active`
- `state.combat` = `active ? { round, currentIdx, turnOrder } : null`
- `actors` (CombatActorRow-shaped) = `encounter.monsters` mapped to
  `{ id, name, hpCurrent, hpMax, isAlive, conditions, initiative }` (monsters
  only; PCs are looked up by the tracker from the existing party/state snapshot).
  The per-actor `initiative` is sourced from the matching `turnOrder` entry
  (initiative lives in `turnOrder`, not on the monster). The executor MUST match
  the real `CombatActorRow` type (read it) — the field list here is the intent,
  the type is the contract.

## Components

| Unit | Responsibility | Change |
|---|---|---|
| `src/ai/master/vault/events-schema.ts` | event validation | Add the 6 encounter event types + payload validation; relax the "character UUID required" rule for encounter events |
| `src/ai/master/vault/projector.ts` | replay → views | Add the EncounterState reducer; `replayEvents` builds it alongside the char Map; serialize `combat.md` |
| `src/ai/master/vault/` EventsWriter / `regenerateAffectedViews` | view regen | Regenerate `combat.md` when an encounter event is applied |
| `src/ai/master/vault/snapshot-reader.ts` (~153-216) | vault → snapshot state | Replace hard-coded `inCombat:false, combat:null` with the encounter-derived `combat`/`inCombat` |
| `src/sessions/client-snapshot.ts` (~83-117) | snapshot → client | For vault campaigns, source `actors` from the vault encounter view instead of always Postgres `combat_actors` |
| `tests/ai/master/vault/` (new) | headless verification | Combat reducer + `combat.md` round-trip + snapshot-shape tests |

## Testing (headless — no LLM)

1. **Reducer:** apply event sequences (`combat_start` → `monster_spawn` ×2 →
   `initiative_set` → `turn_advance` ×N → `monster_hp_change` → `combat_end`) →
   assert EncounterState at each step (round wrap on `turn_advance`, `isAlive`
   flips at `hpCurrent ≤ 0`, `combat_end` → `active:false`).
2. **`combat.md` round-trip:** event → state → serialize view → re-read → assert
   state is recoverable (property: derivable back), mirroring the Phase 02
   round-trip pattern.
3. **Replay determinism:** replaying the same `events.md` N times → identical
   EncounterState (the deterministic-`id` invariant).
4. **Snapshot shape:** `buildClientSnapshot` for a vault campaign mid-encounter
   surfaces `state.combat = { round, currentIdx, turnOrder }`, `state.inCombat =
   true`, and `actors` in the exact shape `CombatTracker` consumes; after
   `combat_end`, `combat = null, inCombat = false, actors = []`.
5. **Regression:** the existing per-character projector tests stay green
   (encounter reducer is additive); a `combat_start`-free `events.md` produces no
   `combat.md` change and an empty/absent encounter.

## Error handling / edge cases

- **Out-of-order / malformed events:** `monster_hp_change` / `initiative_set`
  referencing an unknown id, or `turn_advance` with no active encounter → the
  reducer skips/ignores defensively (no throw), matching the projector's existing
  tolerance; tests cover these.
- **`hpCurrent` clamp:** never below 0; `isAlive=false` at 0. Healing a dead
  monster above 0 sets `isAlive=true` (additive delta model).
- **No encounter:** absent `combat_start` ⇒ `active:false` ⇒ snapshot
  `inCombat:false, combat:null, actors:[]` (today's behavior preserved for
  non-combat campaigns).
- **PC HP source:** the encounter never stores PC HP; the tracker reads PC rows
  from the party snapshot (single source of truth, no divergence).

## Non-goals (explicit)

- NO `apply_event` tool / dispatcher exposure for combat events, NO prompt block,
  NO bestiary content, NO PC↔monster turn interleaving driving the master — all
  **D2**.
- The `sourceOfTruth: 'vault'` flip for the One Piece campaign (so the LIVE UI
  reads vault state incl. combat) is a **D2** operator prerequisite, NOT D1. D1's
  snapshot tests construct a `sourceOfTruth: 'vault'` campaign *in-test*, so D1
  needs no live campaign flip and stays fully headless.
- NO action economy (action/bonus/reaction/movement/position), NO in-combat
  conditions events — **D3**.
- NO writes to Postgres `session_state.combat` / `combat_actors` (that was the
  rejected option A).
- NO change to `CombatTracker` rendering logic (it is reused unchanged).

## Verification of success

A headless test applies a full combat event sequence to a vault campaign's
`events.md`, and `buildClientSnapshot` surfaces a populated `combat` +
monster `actors` in the exact shape `CombatTracker` renders — with `combat.md`
round-tripping and replay being deterministic. No Postgres combat state is
written. The LLM is not involved (that is D2). Existing vault tests stay green.
