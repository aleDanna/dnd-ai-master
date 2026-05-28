# Phase 7: Vault Combat Playable (D2) - Context

**Gathered:** 2026-05-28
**Status:** Ready for planning
**Source:** PRD Express Path (`docs/superpowers/specs/2026-05-28-vault-combat-d2-playable-design.md`)

<domain>
## Phase Boundary

Make vault combat **LLM-playable** on top of D1 (Phase 06, which built the
headless event→reducer→`combat.md`→tracker pipeline). The master starts/runs/ends
combat by emitting the D1 encounter events via `apply_event`; monsters come from a
seeded SRD bestiary plus master-invented custom bosses; turns interleave PCs and
monsters (the master acts for monsters); the combat renders live in the existing
`CombatTracker`. Sub-phase **D2** of piece D (combat). D3 (action economy +
in-combat conditions) is OUT.

5 pieces, **one phase, internal waves**: (1) tool exposure, (2) Combat-lifecycle
prompt block, (3) bestiary seed, (4) turn interleaving [risky core], (5)
`sourceOfTruth` flip + smoke.
</domain>

<decisions>
## Implementation Decisions

### Turn interleaving (LOCKED — driven by turnOrder)
- In an active encounter, the **turn route** (`route.ts` vault branch) derives the
  next turn from `EncounterState.turnOrder[currentIdx]`, NOT from prose
  `detectAddressee`:
  - actor is a **PC UUID** (in `party`) → set `currentPlayerCharacterId` to it +
    emit `turn-change`.
  - actor is a **monster id** (not in `party`) → no PC handoff (the master runs
    the monster turn itself within its response and advances).
- The master is instructed (prompt) to narrate + advance through **consecutive
  monster turns** and **stop on a PC turn** (do NOT act for the PC — Phase 04
  anti-railroading holds).
- **Fallback**: if the encounter is inactive, `turnOrder` is empty/stale, or
  reading it fails → fall back to the existing `detectAddressee`/
  `computeTurnAdvance` path. **Non-combat handoff is unchanged** (regression test).
- This is the **risky core** — must not alter non-combat multiplayer handoff.

### Bestiary (LOCKED — seed 180 + custom via fat payload)
- `scripts/seed-bestiary.ts` reads `data/monsters.csv` (180 rows; `srd_monster`
  columns) → writes `data/vault/handbook/monsters/<slug>.md` (committed static
  vault). Frontmatter: `name`, `hpMax` (leading int of `hp`), `ac` (leading int of
  `armor_class`), `initiativeBonus` (`floor((dex-10)/2)`), + `cr`/`xp` + an
  actions/abilities body for narration. The 4 spawn keys map 1:1 to `monster_spawn`.
- **Custom campaign bosses** (Alduin/Skyrim, Barbanera/One Piece) need NO file —
  the master invents stats and puts them in the **fat `monster_spawn` payload**
  (D1 already carries the full stat block). Prompt rule: standard → read
  `handbook/monsters/<slug>.md`; themed boss → invent + inline.

### Tool exposure (LOCKED — reuse apply_event)
- `tools.ts`: relax the UUID guard (`~tools.ts:283-285`) for `ENCOUNTER_EVENT_TYPES`
  — `if (type !== 'campaign_initialized' && !ENCOUNTER_EVENT_TYPES.has(type)) { …UUID check… }`.
  (`validateEvent` already accepts the 6 types; persist + `combat.md` regen already
  route them — the guard is the only blocker.)
- Extend the `apply_event` `input_schema` `description` (`~tools.ts:95-101`) to list
  the 6 encounter types + payload shapes. Add `data/vault/tools/apply_event.md` +
  an `apply_event` entry in `data/vault/tools/index.md` (currently 3 tools, no
  apply_event entry). NO new tool.

### Combat-lifecycle prompt block (LOCKED)
- In `buildVaultSystemPrompt`, after `applyEventMention`, **gated on
  `vaultMutations === true`**, **REQ-022 byte-stable** (deterministic; each physical
  line an explicit array element; no `Date.now`/`Math.random`/`process.env`).
- Content (semantics LOCKED, wording at discretion): the lifecycle (`combat_start`
  → `monster_spawn` per enemy → `initiative_set` with PC UUIDs + monster ids → per
  turn `monster_hp_change`/`turn_advance` → `combat_end`; tracker at
  `campaigns/<id>/combat.md`); the monster-stats rule; the turn rule (run monster
  turns, stop on a PC turn; PC attack/damage rolls use the Phase 05 `## Rolls`
  surface).

### sourceOfTruth flip (LOCKED — operator checkpoint)
- Set One Piece `settings.sourceOfTruth = 'vault'` so the live UI reads state
  (incl. combat) from the vault. Verify BOTH the PC mechanics-pane (HP/conditions
  from `characters/<slug>.md`) AND the combat-tracker (`combat.md`) render. Operator
  smoke: play a fight on One Piece (gemma4).

### Gating (LOCKED)
- Combat is a mutation feature → the Combat-lifecycle prompt block is gated on
  `vaultMutations === true`. No new per-campaign pref in v1.

### Claude's Discretion
- Exact prompt wording; the bestiary markdown body layout; the precise route
  refactor for the turnOrder-driven handoff (as long as non-combat is unchanged +
  the fallback holds); the seed-script structure.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec
- `docs/superpowers/specs/2026-05-28-vault-combat-d2-playable-design.md` — full design (this CONTEXT derives from it).
- `.planning/phases/06-vault-combat-state-foundation-d1/06-CONTEXT.md` + `06-01-SUMMARY.md` + `06-02-SUMMARY.md` — what D1 built (event types, EncounterState shape, `combat.md`, snapshot wiring).

### Code to modify
- `src/ai/master/vault/tools.ts` — UUID-guard skip for `ENCOUNTER_EVENT_TYPES` (~:283-285); extend `apply_event` `input_schema` description (~:95-101).
- `src/ai/master/vault/prompt-builder.ts` — add the `vaultMutations`-gated Combat-lifecycle block after `applyEventMention`; REQ-022 byte-stable (see `__forbidden-patterns.ts`).
- `src/app/api/sessions/[id]/turn/route.ts` — vault branch (~:340-425) turn handoff: drive from `EncounterState.turnOrder` in combat, fallback to `detectAddressee`/`computeTurnAdvance`.
- `scripts/seed-bestiary.ts` (new) + `data/vault/handbook/monsters/*.md` (generated, committed) + `data/vault/tools/apply_event.md` (new) + `data/vault/tools/index.md`.
- One Piece campaign settings — `sourceOfTruth:'vault'` (data change; pattern in `scripts/_set-campaign-model.ts`).

### Reference (do NOT modify — pattern/contract source)
- `src/ai/master/vault/events-schema.ts` — `ENCOUNTER_EVENT_TYPES` set + the 6 event payload shapes (advertise these).
- `src/ai/master/vault/projector.ts` — `EncounterState` shape (`turnOrder`, `monsters`) the route reads.
- `src/multiplayer/turn-advance.ts` — `computeTurnAdvance` + `detectAddressee` (the fallback; do NOT break non-combat behavior).
- `src/db/schema/srd-monster.ts` + `data/monsters.csv` — bestiary data source (180 rows; columns `slug,name,size,type,ac,hp,...,dex,...,cr,xp,traits,actions`).
- `src/components/game/combat-tracker.tsx` — the consumer (already wired by D1; reused unchanged).
</canonical_refs>

<specifics>
## Specific Ideas

- D1 research confirmed: `apply_event` already accepts the 6 types (validate +
  persist + regen) — the UUID guard is the ONLY blocker; the schema description is
  the ONLY advertising gap. `monster_spawn.id` / `initiative_set.actorId` are NOT
  UUID-checked → the master invents monster ids freely.
- Single-PC party (One Piece) makes interleaving trivial (master runs monster
  turns, hands back to the one PC); logic generalizes to multi-PC.
- Sample CSV (goblin): `hp 7 (2d6)`, `ac 15`, `dex 14` → `hpMax:7, ac:15,
  initiativeBonus:2`. 180 rows total.
- Same automated-vs-smoke split as prior phases: unit tests verify tool exposure +
  prompt block (+REQ-022) + bestiary seed + turn-route interleaving (+ non-combat
  regression); model obedience to the lifecycle is observed in the operator smoke.
</specifics>

<deferred>
## Deferred Ideas

- D3: action economy (action/bonus/reaction/movement/positions) + in-combat
  monster condition events.
- Persistent campaign-specific bestiary for custom monsters (cross-encounter reuse
  of a themed boss) — custom monsters currently live only in the `monster_spawn`
  event (replayable, but re-spawned each encounter).
- Multi-monster tactical AI — the master narrates monster actions free-form.
- A separate per-campaign `combatEnabled` pref (v1 gates on `vaultMutations`).
</deferred>

---

*Phase: 07-vault-combat-playable-d2*
*Context gathered: 2026-05-28 via PRD Express Path*
