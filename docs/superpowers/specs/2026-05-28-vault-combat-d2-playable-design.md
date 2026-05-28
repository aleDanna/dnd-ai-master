# Design — Vault Combat D2: Playable (LLM-driven)

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — ready for implementation plan
**Type:** Production feature (vault path game-mechanics, piece D — sub-phase D2 of 3).

## Purpose

D1 (Phase 06) built the **headless** combat state foundation: 6 encounter-scoped
event types → `EncounterState` reducer → `combat.md` view → snapshot wiring that
feeds the existing `CombatTracker`. But nothing drives it yet — the events are
applied only by tests, the LLM doesn't know they exist, there are no monsters,
turn handoff ignores combat, and One Piece reads state from Postgres.

**D2 makes combat playable:** the master starts/runs/ends combat by emitting the
D1 events, monsters come from a seeded SRD bestiary (plus master-invented custom
bosses), turns interleave PCs and monsters (the master acts for monsters), and
the combat renders live in the tracker. Piece D sub-phases: D1 = state (done);
**D2 = playable (this)**; D3 = action-economy + in-combat conditions (later).

## Scope decisions (from brainstorming)

- **Turn interleaving driven by `EncounterState.turnOrder`** (chosen over
  master-prose self-management). In an active encounter, the turn route reads
  `combat.md`/`turnOrder[currentIdx]` to decide handoff. NOT prose-addressee.
- **Bestiary = seed all 180 SRD monsters from `data/monsters.csv`** into
  `data/vault/handbook/monsters/<slug>.md` (committed static vault) **+ the master
  may invent custom campaign bosses** (Alduin/Skyrim, Barbanera/One Piece) by
  putting stats directly in the **fat `monster_spawn` payload** (D1 already
  supports this — no file needed for custom monsters).
- **Reuse `apply_event`** for the encounter events (no new tool). The only
  dispatcher change is relaxing the UUID guard for `ENCOUNTER_EVENT_TYPES`.
- **One phase, internal waves.** Wave 1 = tool exposure + prompt block + bestiary
  seed; Wave 2 = turn interleaving; + an operator-smoke checkpoint (sourceOfTruth
  flip + play a fight). No piece ships alone.
- **Gated on `vaultMutations`.** Combat is a mutation feature; the combat prompt
  block is emitted when `vaultMutations === true` (like `applyEventMention`). No
  new per-campaign pref in v1.

## Architecture

Event-sourced combat on top of D1. The master drives the lifecycle by emitting
D1 events through `apply_event`; D1's pipeline persists them to `events.md`,
regenerates `combat.md`, and surfaces the encounter to the `CombatTracker`. The
turn route reads the resulting `EncounterState` to interleave PC/monster turns.

```
master turn → apply_event(combat_start / monster_spawn / initiative_set /
              monster_hp_change / turn_advance / combat_end)
            → [D1] events.md → combat.md → snapshot → CombatTracker
turn route (vault branch, combat active) → read EncounterState.turnOrder[currentIdx]
            → PC ? set currentPlayerCharacterId : (master keeps acting)
            → fallback to detectAddressee if the model didn't advance
```

## The 5 pieces

### 1. Tool exposure (`src/ai/master/vault/tools.ts`)
- **Relax the UUID guard** (currently `tools.ts:283-285` rejects events with no
  `payload.character`): skip it for `ENCOUNTER_EVENT_TYPES` —
  `if (type !== 'campaign_initialized' && !ENCOUNTER_EVENT_TYPES.has(type)) { …UUID check… }`.
  (`validateEvent` already accepts the 6 types; persist + `combat.md` regen
  already route them — this guard is the only blocker.)
- **Advertise the schema**: extend the `apply_event` `input_schema` `description`
  strings (`tools.ts:95-101`) to list the 6 encounter types + their payload
  shapes. Add `data/vault/tools/apply_event.md` and an `apply_event` entry in
  `data/vault/tools/index.md` (which currently lists only 3 tools).

### 2. Combat-lifecycle prompt block (`src/ai/master/vault/prompt-builder.ts`)
- Inserted after `applyEventMention`, **gated on `vaultMutations === true`**,
  **REQ-022 byte-stable** (deterministic; each physical line an explicit array
  element; no `Date.now`/`Math.random`/`process.env`).
- Content (semantics LOCKED; wording at implementer discretion):
  - **Lifecycle**: `combat_start` → one `monster_spawn` per enemy → `initiative_set`
    with the full order (PC UUIDs + monster ids) → each turn `monster_hp_change` /
    `turn_advance` → `combat_end` when the fight ends. The live tracker is
    `campaigns/<id>/combat.md`.
  - **Monster stats rule**: for a standard creature, read
    `handbook/monsters/<slug>.md` and copy `name/hpMax/ac/initiativeBonus` into the
    `monster_spawn` payload; for a campaign-specific boss not in the bestiary,
    invent appropriate stats and put them in the payload.
  - **Turn rule** (pairs with piece 4): on a monster's turn, narrate its action,
    apply effects (`monster_hp_change` and/or a PC `hp_change`), and `turn_advance`;
    run through consecutive monster turns; **stop when it becomes a PC's turn** and
    let that player act (do NOT act for the PC — Phase 04 anti-railroading still
    holds). PC attack/damage rolls use the Phase 05 `## Rolls` manual-roll surface.

### 3. Bestiary (`scripts/seed-bestiary.ts` + `data/vault/handbook/monsters/`)
- A committed seed script reads `data/monsters.csv` (180 rows; `srd_monster`
  columns) and writes one `data/vault/handbook/monsters/<slug>.md` per monster:
  frontmatter `name`, `hpMax` (leading int of `hp`), `ac` (leading int of
  `armor_class`), `initiativeBonus` (`floor((dex-10)/2)`), plus `cr`/`xp` and an
  `## Actions`/abilities body (from `actions`/`traits`) for narration. The 4
  spawn-relevant keys map 1:1 to the `monster_spawn` payload.
- Output is committed (static vault knowledge). The script is kept + re-runnable.
- **Custom monsters** need no file — the fat `monster_spawn` payload carries
  invented stats (per the monster-stats rule in piece 2).

### 4. Turn interleaving (`src/app/api/sessions/[id]/turn/route.ts` vault branch)
- After the vault loop, when the encounter is active (`EncounterState.active`),
  derive the next turn from `turnOrder[currentIdx]` instead of `detectAddressee`:
  - actor is a **PC UUID** (in `party`) → set `currentPlayerCharacterId` to it,
    emit the `turn-change` (hand the turn to that player).
  - actor is a **monster id** (not in `party`) → the master should have run it
    already; do NOT hand off to a player. (The prompt tells the master to advance
    through monster turns and stop on a PC turn, so a well-behaved turn ends with
    `currentIdx` on a PC.)
- **Fallback**: if reading the encounter fails, the encounter is inactive, or
  `turnOrder` is empty/stale, fall back to the existing
  `detectAddressee`/`computeTurnAdvance` path (unchanged). Non-combat turns are
  completely unchanged.
- This is the **risky core** — it must not alter non-combat multiplayer handoff
  (regression tests required).

### 5. sourceOfTruth flip + smoke (operator checkpoint)
- Set One Piece `settings.sourceOfTruth = 'vault'` so the live UI reads state
  (incl. combat) from the vault. Verify BOTH the PC mechanics-pane AND the
  combat-tracker render correctly from the vault views (PC HP/conditions from
  `characters/<slug>.md`, combat from `combat.md`).
- Operator smoke: start a fight in One Piece (gemma4) — master spawns a monster,
  sets initiative, the tracker shows it, turns alternate (player acts on the PC's
  turn, master runs the monster's), HP changes land, combat ends.

## Components

| Unit | Change |
|---|---|
| `src/ai/master/vault/tools.ts` | UUID-guard skip for `ENCOUNTER_EVENT_TYPES`; extend `apply_event` schema description with the 6 types + payloads |
| `data/vault/tools/apply_event.md` + `index.md` | New per-tool doc + index entry |
| `src/ai/master/vault/prompt-builder.ts` | `vaultMutations`-gated Combat-lifecycle block (REQ-022-stable) |
| `scripts/seed-bestiary.ts` (new) + `data/vault/handbook/monsters/*.md` (generated, committed) | SRD bestiary seed |
| `src/app/api/sessions/[id]/turn/route.ts` (vault branch) | Combat turn interleaving from `EncounterState.turnOrder`, with `detectAddressee` fallback |
| One Piece campaign settings | `sourceOfTruth: 'vault'` (data change, operator) |
| tests | schema-includes-6-types; prompt-block content + REQ-022 stability; bestiary-seed output; guard-skip dispatch; **turn-route combat-interleaving + non-combat regression** |

## Testing

1. **Tool exposure**: `apply_event` dispatch accepts an encounter event (no
   `payload.character`) and rejects a malformed one; the schema description string
   contains all 6 type names.
2. **Prompt block**: contains the lifecycle event names, the monster-stats rule,
   the turn rule; gated (absent when `vaultMutations` false); REQ-022 1000-build
   stability; read-only/no-mutations hash paths unaffected.
3. **Bestiary seed**: running the script on `data/monsters.csv` yields 180 files;
   spot-check `goblin.md` frontmatter (`hpMax:7, ac:15, initiativeBonus:2`) maps to
   a valid `monster_spawn` payload.
4. **Turn interleaving** (the critical suite): a combat fixture (PC + monster
   turnOrder) → route hands to the PC when `currentIdx` is a PC, does NOT hand off
   when it's a monster; falls back to `detectAddressee` when the encounter is
   inactive; **non-combat multiplayer handoff is byte-for-byte unchanged**
   (regression).
5. **Operator smoke** (checkpoint): a real fight on One Piece renders + plays.

## Error handling / edge cases

- **Model fails to advance to a PC turn** (leaves `currentIdx` on a monster): the
  route does not hand off; the `detectAddressee` fallback catches the common case
  (the master addressed the next PC by name). Tighten via prompt if observed.
- **Single-PC party (One Piece)**: interleaving is trivial — master runs monster
  turns, hands back to the one PC. The logic generalizes to multi-PC.
- **`combat_end` mid-turnOrder**: encounter `active:false` → route reverts to the
  normal non-combat handoff next turn.
- **Custom monster consistency**: invented stats live in the `monster_spawn`
  event (replayable); cross-encounter reuse of a custom boss is deferred.

## Non-goals (explicit)

- NO action economy (action/bonus/reaction/movement/positions) or in-combat
  monster condition events — **D3**.
- NO persistent campaign-specific bestiary for custom monsters (cross-encounter
  reuse) — deferred refinement.
- NO multi-monster tactical AI — the master narrates monster actions free-form.
- NO new combat tool (reuse `apply_event`); NO change to `CombatTracker`
  rendering (D1 reused it).

## Verification of success

On One Piece (gemma4, `vaultMutations` + `sourceOfTruth:'vault'`): the operator
triggers a fight; the master spawns a monster (SRD via bestiary or a themed
custom boss), sets initiative, and the `CombatTracker` shows the encounter; turns
alternate (the player acts on the PC's turn via the 🎲 surface, the master runs
the monster's turn and applies `monster_hp_change`); `combat_end` clears it.
Automated tests verify tool exposure, the prompt block (+ REQ-022), the bestiary
seed, and — critically — the turn-route interleaving WITH a non-combat regression
guard. Model obedience to the lifecycle is observed in the smoke, not unit-tested.
