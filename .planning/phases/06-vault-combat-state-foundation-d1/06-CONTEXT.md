# Phase 6: Vault Combat State Foundation (D1) - Context

**Gathered:** 2026-05-28
**Status:** Ready for planning
**Source:** PRD Express Path (`docs/superpowers/specs/2026-05-28-vault-combat-d1-state-foundation-design.md`)

<domain>
## Phase Boundary

Build the **combat state foundation** for the vault path, **event-sourced and
headless**. Add encounter-scoped event types to `events.md`, a projector
encounter reducer, a `combat.md` materialized view, and snapshot wiring so the
existing backend-agnostic `CombatTracker` renders vault combat state. Events are
applied by **tests**, not the LLM.

This is **sub-phase D1** of piece D (combat). Architecture chosen in
brainstorming: **vault-native event sourcing** (option B) — NOT a bridge to the
Postgres combat engine (option A, rejected) and NOT LLM-narrated-without-state
(option C, rejected). Decomposed infra-first: **D1 = state foundation (this)**;
D2 = LLM tools/prompt/bestiary/turn-interleaving; D3 = action economy + in-combat
conditions.

**Out of D1:** any LLM/tool/prompt/bestiary surface, PC↔monster turn
interleaving driving the master, action economy, in-combat condition events, and
any write to Postgres `session_state.combat` / `combat_actors`.
</domain>

<decisions>
## Implementation Decisions

### Architecture (LOCKED — option B)
- **Vault-native event sourcing.** Combat state lives in `events.md` (append-only,
  replayable, source of truth) + a `combat.md` materialized view. No Postgres
  combat writes (option A rejected). Honors REQ-004 / REQ-007.

### Event lane (LOCKED)
- **One `events.md`** — new encounter-scoped event types added to the existing
  `events-schema.ts`, not a separate log.
- The per-PC **"character UUID required" guard is relaxed** for encounter events
  (they have no `payload.character`).

### Monster identity & stats (LOCKED)
- **`monster_spawn` is fat / self-contained**: payload carries a **deterministic
  `id`** (assigned by the spawner, *in the payload* → deterministic replay) AND
  the full stat block. Replay never depends on mutable external files. The
  *source* of the stats (bestiary markdown) is D2; in D1 the **test** supplies them.

### State ownership & reuse (LOCKED)
- **PC HP reused** from the existing per-character views — the encounter
  references PCs by UUID in `turnOrder`; only **monsters** live in encounter state.
- **`CombatTracker` reused unchanged** (already backend-agnostic — takes
  `Pick<SessionStateRow,'inCombat'|'combat'>` + `CombatActorRow[]`).
- **No action economy** (turnState/position/movement/budgets) and **no in-combat
  condition events** in D1 — those are D3. Actor shape is the minimal renderable
  subset.

### Event schema (LOCKED — 6 encounter-scoped types)
| type | payload | reducer effect |
|---|---|---|
| `combat_start` | `{}` | begin encounter: `active=true, round=1, currentIdx=0, turnOrder=[], monsters=[]` (re-initializes a fresh encounter) |
| `monster_spawn` | `{ id: string, name: string, hpMax: number, ac?: number, initiativeBonus?: number }` | append monster `{ id, name, hpMax, hpCurrent: hpMax, ac, initiativeBonus, isAlive: true, conditions: [] }` |
| `initiative_set` | `{ order: Array<{ actorId: string, initiative: number }> }` | `turnOrder = order` (PC UUIDs + monster ids), `currentIdx=0` |
| `turn_advance` | `{}` | `currentIdx++`; past end → `currentIdx=0, round++` |
| `monster_hp_change` | `{ id: string, delta: number }` | `hpCurrent += delta` (clamp ≥0); `isAlive = hpCurrent > 0` |
| `combat_end` | `{}` | `active=false` |

### EncounterState + view (LOCKED)
- Reducer output: `{ active, round, currentIdx, turnOrder: [{actorId, initiative}], monsters: [{id, name, hpCurrent, hpMax, ac?, initiativeBonus?, isAlive, conditions: string[]}] }`.
- Serialized to `combat.md` (frontmatter). When `active === false` → "no encounter".
- **Snapshot mapping → CombatTracker:** `state.inCombat = active`; `state.combat = active ? {round, currentIdx, turnOrder} : null`; `actors` = monsters mapped to the `CombatActorRow` shape (per-actor `initiative` sourced from the matching `turnOrder` entry; PCs looked up by the tracker from the party snapshot). **The executor MUST match the real `CombatActorRow` type — that type is the contract.**

### sourceOfTruth (LOCKED — D2 prerequisite, not D1)
- The vault state pivot in `client-snapshot.ts` fires only when
  `campaign.settings.sourceOfTruth === 'vault'` (default `'postgres'`). Flipping
  One Piece to `'vault'` (so the LIVE UI shows vault combat) is a **D2** operator
  step. **D1 snapshot tests construct a `sourceOfTruth:'vault'` campaign in-test**
  → D1 needs no live flip and stays headless.

### Claude's Discretion
- Exact `combat.md` filename/frontmatter layout, the reducer's internal structure,
  and how the EncounterState is threaded through `replayEvents` — implementer's
  choice, as long as the event types/payloads, the snapshot mapping, and headless
  testability hold.
- Defensive handling of malformed/out-of-order events (skip, don't throw) —
  match the existing projector's tolerance.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec
- `docs/superpowers/specs/2026-05-28-vault-combat-d1-state-foundation-design.md` — full design (this CONTEXT derives from it).

### Code to modify
- `src/ai/master/vault/events-schema.ts` — add the 6 encounter event types + validation; relax the UUID-required rule for them.
- `src/ai/master/vault/projector.ts` — add the EncounterState reducer alongside the per-character `Map`; `replayEvents` builds it; serialize `combat.md`.
- `src/ai/master/vault/` EventsWriter / `regenerateAffectedViews` — regenerate `combat.md` when an encounter event is applied (find the exact module via grep — `EventsWriter.applyEvent`).
- `src/ai/master/vault/snapshot-reader.ts` (~lines 153-216) — replace hard-coded `inCombat:false, combat:null` with encounter-derived values.
- `src/sessions/client-snapshot.ts` (~lines 83-117) — for vault campaigns, source `actors` from the vault encounter view instead of always Postgres.

### Reference (do NOT modify — shape/pattern source)
- `src/components/game/combat-tracker.tsx` — the consumed shape (`state.combat.{round,currentIdx,turnOrder}` + per-actor `{name,hpCurrent,hpMax,isAlive,conditions}`); `CombatActorRow` type is the contract for `actors`.
- `src/db/schema/combat-actors.ts` + `src/db/schema/session-state.ts` — the `CombatActorRow` / `combat` JSON shapes the snapshot mapping must produce.
- `src/ai/master/vault/projector.ts` existing per-character reducer + `replayEvents` + `serializeView` — the pattern the encounter reducer mirrors.
- `events.md` format (one JSONL event per line: `{id, version, type, payload, timestamp}`) — see `~/.dnd-ai-master/vault/campaigns/<id>/events.md`.
</canonical_refs>

<specifics>
## Specific Ideas

- Research facts (2026-05-28): `CombatTracker` is already backend-agnostic; monsters are greenfield (`seedMonster` is dead code, `data/vault/handbook/monsters/` is empty); the vault path is Postgres-free for state by default; `apply_event` is character-scoped (28 types) so combat needs a new encounter lane.
- Headless test pattern mirrors the Phase 02 round-trip property test (event → state → view → state derivable back) and the REQ-022-style determinism check (replay N times → identical state).
- Real campaign data layout (verified): story/messages in Postgres `session_messages`; game state in vault `events.md` + `characters/<slug>-<id8>.md` views under `~/.dnd-ai-master/vault/campaigns/<id>/`.
</specifics>

<deferred>
## Deferred Ideas

- D2: LLM combat tool/dispatcher exposure for the encounter events, the "Combat lifecycle" prompt block, the bestiary (`handbook/monsters/<slug>.md`), PC↔monster turn interleaving, and the One Piece `sourceOfTruth:'vault'` flip.
- D3: action economy (action/bonus/reaction/movement, positions) + in-combat condition events.
- Rejected: option A (bridge to Postgres `session_state.combat` / `combat_actors`); option C (LLM-narrated combat without a state machine).
</deferred>

---

*Phase: 06-vault-combat-state-foundation-d1*
*Context gathered: 2026-05-28 via PRD Express Path*
