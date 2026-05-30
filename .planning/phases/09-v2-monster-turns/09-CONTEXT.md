# Phase 09: v2 Monster Turns - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning
**Source:** Interactive discuss-phase. Builds on Phase 08 (v1 player-attack resolver) + the combat-resolver groundwork decomposition (v1 player attacks / **v2 monster turns** / v3 polish).

<domain>
## Phase Boundary

Move **MONSTER-turn mechanical resolution server-side**. Today a prompt directive
(`prompt-builder.ts:209-217`, "Area C — Turn rule") tells the LLM: *"on a monster's
turn narrate its action, apply `hp_change` on the target PC, `turn_advance`, run
through consecutive monster turns automatically, stop on a PC's turn"* — and the
local model (gemma4, qwen3) **fails it**, the exact ceiling v1 fixed for player
attacks (free-narrates outcomes, ignores rolled numbers, never applies HP/turns).

v2: when the active actor in an active encounter is a **MONSTER**, the server rolls
the monster's attack vs the target PC's AC (from Postgres), applies damage to the
PC's HP (`hp_change`), advances the turn, and **loops through consecutive monster
turns** until a PC's turn (or a stop condition). Then the existing 07-03
`resolveCombatHandoff` returns control to the PC. **The LLM only NARRATES** the
server-determined monster actions.

**v2 scope (LOCKED):** monster-turn attack resolution mechanics + the consecutive
monster-turn loop + the PC-AC bridge + LLM-suggested difficulty for custom monsters.

**NOT in scope (= v3):** crit-damage doubling, resistances/immunities/cover/
advantage, multiattack, real death-save mechanics + true game-over, auto
`combat_end`, conditions. (See `<deferred>`.)
</domain>

<decisions>
## Implementation Decisions

### Trigger & turn loop

- **D-01 — Trigger is GENERAL ("active actor is a monster"):** After processing the
  player's message + any resulting `turn_advance` (incl. the v1 player-attack
  resolution), read the post-turn `EncounterState` and inspect the active actor
  `turnOrder[currentIdx].actorId`. If it matches a **live** `monsters[].id` → enter
  the monster-turn loop. Trigger is general (NOT only "after a player attack") so it
  also covers monster-first initiative and PC non-attack turns. Gate:
  `vaultMutations && encounter.active`.
- **D-02 — Server-side loop, SAME request:** Resolve consecutive monster turns within
  the same HTTP request: per monster turn → roll attack vs target PC AC → on hit emit
  `hp_change(PC, -damage)` → emit `turn_advance` → repeat. After the loop, the existing
  07-03 `resolveCombatHandoff` hands to the next PC. Single round-trip; one narration
  pass at the end (D-15).
- **D-03 — Loop stop conditions + safety cap:** Stop when **(a)** the active actor is a
  live PC; **(b)** no live targetable PC remains (all PCs at 0 HP — see D-14); **(c)** a
  safety iteration cap is reached (anti-infinite-loop, in case reducer guards fail to
  advance). Auto `combat_end` is NOT emitted by v2 (= v3; existing flow unchanged, like
  v1).

### Monster attack data source — 3-level fallback

- **D-04 — Bestiary monster → REAL stats (prose parse):** If the monster name/slug
  matches `data/vault/handbook/monsters/<slug>.md`, parse its `## Actions` prose (e.g.
  `Scimitar: +4 to hit, 5ft, 1d6+2 slashing`) → use the real attack bonus + damage dice.
  Honors the master rulebook: §8 *"Reskin existing stat blocks rather than invent"*,
  §7.6 *"monsters aren't just HP and AC."* The SRD parser `parseNamedBlocks`
  (`src/srd/parsers/monsters.ts:65`) splits actions into `{name, description}` but keeps
  the description as **prose** — v2 adds a small regex to extract `+N to hit` and
  `XdY±Z` from the description.
- **D-05 — Custom monster → LLM-suggested difficulty → deterministic table:** For
  monsters NOT in the bestiary (LLM-invented, e.g. "Veyra"), the LLM provides a **coarse
  difficulty hint** in the `monster_spawn` payload; the **SERVER** maps it
  deterministically to attack bonus + damage dice via a tunable table (loosely the DMG
  "Monster Statistics by Challenge Rating" guidance). Rationale: choosing a *difficulty*
  is a narrative judgment (LLM strength), not arithmetic (LLM weakness) — the server
  stays the SOLE authority on mechanics; the hint is just an input, exactly like `hpMax`
  already is. A boss the LLM imagines (high difficulty) automatically hits harder,
  deterministically.
- **D-06 — Base default fallback:** If the difficulty hint is omitted AND there is no
  bestiary match → base default **+4 to hit / 1d6 damage** (symmetric with v1's defaults:
  monster AC 12, player damage die 1d6; goblin-tier, forgiving — appropriate for a
  minimal slice on local models). Use named constants
  (`DEFAULT_MONSTER_ATTACK_BONUS` / `DEFAULT_MONSTER_DAMAGE_DIE`), mirroring v1's
  `DEFAULT_MONSTER_AC`.
- **D-07 — Sequencing note (NOT a scope cut):** The real operator smoke (One Piece)
  uses **CUSTOM** monsters → the **D-05 `cr`→table path is the one actually exercised**;
  the D-04 bestiary-parse path serves SRD monsters that will NOT appear in that smoke.
  The planner should sequence so D-04 does NOT block the smoke-critical D-05 path (split
  D-04 into its own task, or trim it, if it balloons).

### Additive schema change (consciously accepted deviation)

- **D-08 — `monster_spawn` payload gains an optional difficulty field:** This BREAKS the
  "no event-schema change" property that v1 and the groundwork assumed. It is **additive
  and backward-compatible** (optional field → old events still replay byte-stable).
  **Field:** lean **`cr`** (numeric challenge rating — D&D-native, already in bestiary
  frontmatter `cr:` and `srd_monsters.cr`, the LLM handles CR fluently) over a coarser
  `tier` enum (`minion|standard|elite|boss`); final choice is Claude's discretion at
  planning. Touch points: `events-schema.ts` (`monster_spawn` payload type + validator),
  the `apply_event` tool description (`tools.ts:101`), the combat-lifecycle prompt
  (`prompt-builder.ts` §Monster stats / `monster_spawn` step) to instruct the LLM to
  include it. Accepted consciously to enable D-05.

### Monster attack resolution rules (mirror v1) + determinism

- **D-09 — Hit rule (5e-faithful, mirrors v1):** Server auto-rolls `d20 + attackBonus`
  vs the target PC's AC. `nat1 = auto-miss`, `nat20 = auto-hit`, else `hit = total >= AC`.
  Verified against `rules.md §3.10` and `master_handbook_compact.md §4`. On hit → roll
  damage dice (**NO crit-doubling** — deferred to v3, symmetric with the player path in
  v1) → `hp_change(PC, -total)`.
- **D-10 — Server-side RNG via an INJECTABLE seam:** Unlike v1's pure `resolveCombat`
  (the player rolled client-side, so it only *compared* a total), the monster-turn
  resolver MUST roll (d20 + damage) AND pick a random target (D-11). All randomness draws
  from a SINGLE injectable RNG seam (default `src/engine/rand.ts` `defaultRng`,
  crypto-backed) so the resolver stays **headless-testable** with a deterministic RNG —
  preserving v1's testability value. Reuse `src/engine/dice.ts` `rollD20`/`rollDamage`.

### PC target selection

- **D-11 — Random LIVE PC:** The monster attacks a PC chosen at RANDOM among live combat
  participants (in `turnOrder`, HP > 0), drawn from the SAME injected RNG seam (D-10) →
  deterministic in tests. Collapses to the single PC in the 1v1 smoke. (Rejected:
  always-`cpcId` — a monster would always hit the same player in a multi-PC party.)
- **D-12 — PC-AC bridge (MINIMAL):** Extend the route's party select to pull
  `characters.ac` (Postgres, `notNull` → **no PC-AC default needed**;
  `src/db/schema/characters.ts:38`). `abilities`/`proficiencyBonus` are NOT needed in v2
  (the monster uses a default/derived/parsed attack bonus — it does NOT recompute from
  the PC sheet; PC defense only needs AC). Map `actorId` (PC UUID) → `ac`.

### Damage application + PC downed

- **D-13 — Monster→PC damage uses the EXISTING `hp_change` event:** Emit
  `hp_change { character: <PC UUID>, delta: -damage }`. The reducer clamps at 0. **No
  event-schema change for damage application** (`hp_change` already exists,
  `events-schema.ts:261`; matches the current prompt directive `prompt-builder.ts:193`).
- **D-14 — PC at 0 HP → mark KO + stop loop if it was the last PC:** When a hit drops a
  PC to 0 HP, apply `hp_change` (reducer clamps 0); that PC leaves the targetable pool
  (HP > 0, D-11). If the downed PC was the **LAST** live PC → the loop STOPS (D-03b) and
  the narration signals the party KO. Real death-save mechanics (the `death_save_*`
  events exist, `rules.md §3.18`) and true game-over are DEFERRED to v3 / the existing
  flow — v2 just stops cleanly rather than spinning with no target.

### Narration (reuse v1 pattern)

- **D-15 — SINGLE combined narration pass:** After the loop resolves all consecutive
  monster turns, the server builds ONE narration directive listing every monster
  action's outcome (e.g. `[RESOLVED BY SYSTEM: Veyra ti colpisce per 5 danni; il Goblin
  manca] narra in seconda persona…`) → `runVaultToolLoop` in narration-only mode (1 LLM
  call — best for Mac Mini M4 latency, a project constraint) → `enforceResolvedNarration`
  strips any competing roll-requests / leaked event-JSON. Reuses the v1 D-06/D-07 pattern
  (`combat-resolver.ts:252`).
- **D-16 — Suppress the prompt-side monster-turn directive when the server resolves:**
  Neutralize / gate the "Area C — Turn rule" lines (`prompt-builder.ts:209-217`, *"run
  through consecutive monster turns automatically…"*) on a server-resolved monster turn,
  to avoid conflicting instructions — analogous to v1's D-07 player-side suppression in
  `turn-directive.ts`.

### Claude's Discretion

- Difficulty-hint field: `cr` (lean) vs a coarse `tier` enum (D-08).
- The exact difficulty→(attackBonus, damageDice) mapping table (D-05).
- The bestiary-prose regex for `+N to hit` / `XdY±Z` (D-04).
- Exact base-default numbers beyond +4/1d6 and the damage formula (die only vs die + flat) (D-06).
- The safety iteration cap value (D-03c).
- Whether the monster-turn resolver lives in `combat-resolver.ts` or a new sibling file (e.g. `combat-monster-turns.ts`).
- Exactly where in the vault branch of `route.ts` the loop hooks (after the v1 resolution + post-loop encounter read, around the 07-03 handoff).
- How D-16 suppression is implemented (prompt gating vs directive override).
- Narration directive wording (semantics LOCKED: per-monster hit/miss/damage, 2nd person, Italian to match v1's directives).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec / groundwork (this phase's lineage)
- `docs/superpowers/specs/2026-05-29-server-side-combat-resolver-groundwork.md` — the v1/v2/v3 decomposition, the data wrinkle (PC stats in Postgres; monster `actions` is prose), and **open decision #5** (monster attack data: parse prose / structured frontmatter / default). v2 = monster turns.
- `docs/superpowers/specs/2026-05-29-combat-resolver-v1-design.md` — the v1 design v2 extends (resolver contract, narration-only mode, 3-layer testing).

### Prior phase context
- `.planning/phases/08-server-side-combat-resolver-v1-player-attacks/08-CONTEXT.md` — LOCKED v1 decisions; the pattern v2 extends (`resolveCombat`, narration-only, `enforceResolvedNarration`, defaults, edge→null).
- `.planning/phases/06-vault-combat-state-foundation-d1/06-CONTEXT.md` — `EncounterState` shape, the 6 encounter events, `combat.md`, snapshot wiring.
- `.planning/phases/07-vault-combat-playable-d2/07-CONTEXT.md` (+ `07-03`) — turnOrder-driven handoff `resolveCombatHandoff`, per-turn directive, roll-parser tolerance.

### Master rulebook (consulted this session — drove D-04/D-05/D-09/D-14)
- `data/master_handbook.md` §7.6 (Monster Behavior — *not just HP and AC*), §8 (*reskin existing stat blocks*), §8.2 (Improvising Damage table — **environmental only**, NOT a melee default).
- `data/master_handbook_compact.md` §4 (nat20 auto-hit / nat1 auto-miss; *don't invent extra punishments for nat-1*), §7 (Combat), §9 (Death and Consequences — death saves).
- `data/rules.md` §3.10 (Attack Rolls), §3.11 (Critical Hits — double dice; **deferred to v3**), §3.16 (Damage), §3.17–3.18 (HP / 0 HP / Death Saving Throws).

### Code to modify
- `src/app/api/sessions/[id]/turn/combat-resolver.ts` (extend) OR a new sibling (e.g. `combat-monster-turns.ts`) — the monster-turn resolver (pick target, roll via injected RNG, hit rule, emit `hp_change` + `turn_advance`) + the loop driver.
- `src/app/api/sessions/[id]/turn/route.ts` (vault branch) — hook the loop after the v1 player resolution + post-loop encounter read, around the 07-03 handoff; extend the party select with `ac`.
- `src/ai/master/vault/events-schema.ts` — add optional difficulty (`cr?`) to the `monster_spawn` payload (D-08).
- `src/ai/master/vault/tools.ts:101` — update the `apply_event` `monster_spawn` payload description to include the new field.
- `src/ai/master/vault/prompt-builder.ts` — instruct the LLM to include `cr` in `monster_spawn` (§Monster stats / step 2); suppress/gate the "Area C — Turn rule" lines (209-217) when the server resolves (D-16).
- `src/ai/master/vault/turn-directive.ts` — coordinate D-16 suppression (mirror v1's D-07).

### Reference (do NOT modify — pattern/contract source)
- `src/engine/dice.ts` — `rollD20({modifier})`, `rollDamage(formula,{crit})` (server-side rolls); `src/engine/rand.ts` `defaultRng` — the injectable RNG seam (D-10).
- `src/engine/combat/attack.ts` `makeAttack()` (~:137) — the hit rule v2 mirrors (nat20/nat1/≥AC).
- `src/ai/master/vault/projector.ts` — `EncounterState` (`currentIdx`, `turnOrder`, `monsters[]{id,name,ac?,isAlive}`); active actor = `turnOrder[currentIdx].actorId`; monster turn = that id ∈ `monsters`.
- `src/ai/master/vault/events-schema.ts:261` — `hp_change {character, delta}` (monster→PC damage); `:322` `monster_hp_change`; `:321` `turn_advance`; `:271-274` `death_save_*` (v3).
- `src/app/api/sessions/[id]/turn/combat-handoff.ts` — `resolveCombatHandoff` (07-03), runs after the loop to hand to the next PC.
- `src/db/schema/characters.ts:38` — `ac` (notNull); `:35` `abilities`, `:36` `proficiencyBonus` (NOT needed in v2).
- `src/srd/parsers/monsters.ts:65` `parseNamedBlocks` — actions-prose splitter (reference for the D-04 `+N`/`XdY` extraction; it keeps the description as prose).
- `data/vault/handbook/monsters/*.md` — bestiary stat blocks (e.g. `goblin.md`: frontmatter `cr/ac/hpMax/initiativeBonus` + `## Actions` prose).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `enforceResolvedNarration` (`combat-resolver.ts:252`) — strips competing roll-requests / leaked event-JSON; reuse for the monster-turn narration pass (D-15).
- `resolveCombatHandoff` (`combat-handoff.ts`, 07-03) — turnOrder-driven handoff to the next PC; runs after the monster loop.
- `engine/dice.ts` `rollD20`/`rollDamage` + `engine/rand.ts` `defaultRng` — crypto-backed rolls with an RNG seam → inject for headless determinism (D-10).
- `parseNamedBlocks` (`srd/parsers/monsters.ts:65`) — actions-prose splitter (reference for D-04).
- `matchMonster` (`combat-resolver.ts:118`) — case-insensitive name→monster with turnOrder-disambiguation; the bestiary-slug lookup (D-04) can mirror its name-normalization.

### Established Patterns
- **Server resolves mechanics, LLM narrates only** (v1) — v2 extends it to monster turns.
- **"Edge → resolve defensively, never throw / never hard-fail"** (v1 D-10) — applies to no-target, missing data, cap reached.
- **Defaults as named constants** (v1 `DEFAULT_MONSTER_AC = 12`) — add monster-offense defaults (D-06).
- **Narration-only loop + directive** (v1 D-06) — reused with a combined multi-turn directive (D-15).
- **Additive event schema, byte-stable replay** — the `cr?` field must be optional so existing `events.md` replays unchanged (D-08).

### Integration Points
- The monster-turn loop hooks in the vault branch of `route.ts`, after the v1 player resolution and the post-loop encounter read, around the 07-03 handoff.
- The trigger reads the post-`turn_advance` `EncounterState` to decide whether the active actor is a monster (D-01).
- The PC-AC bridge extends the existing party query (route already selects the party ~:131 / ~:560).
</code_context>

<specifics>
## Specific Ideas

- **Smoke scenario:** One Piece campaign, custom monster "Veyra" (NOT in the bestiary) → exercises the D-05 `cr`→table path + random-target (collapses to 1v1) + `hp_change` on the PC + the monster-turn loop + the single combined narration.
- **Bestiary example (D-04 parse target):** `data/vault/handbook/monsters/goblin.md` → `## Actions`: `Scimitar: +4 to hit, 5ft, 1d6+2 slashing. Shortbow: +4 to hit, range 80/320, 1d6+2 piercing.`
- **Difficulty→stats table** loosely follows the DMG "Monster Statistics by Challenge Rating" guidance (attack bonus + damage-per-action scale with CR); the base (+4/1d6) is the floor.
- **Narration directives are written in Italian** (matching the v1 directives in `combat-resolver.ts`), 2nd person.
</specifics>

<deferred>
## Deferred Ideas

### v3 — combat polish
- Crit-damage doubling (nat20 → double dice; `rollDamage(...,{crit:true})` already exists).
- Resistances / immunities / vulnerabilities / cover / advantage–disadvantage (`rules.md §3.12–3.16`).
- Multiattack (monsters with multiple attacks per turn).
- Real death-save mechanics when a PC reaches 0 HP (`death_save_*` events; `rules.md §3.18`) + true party-KO / game-over handling (v2 only stops the loop, D-14).
- Auto `combat_end` when one side is fully down (v2 leaves `combat_end` to the existing flow, like v1).
- Conditions (prone, grappled, frightened, …) applied by monster actions.

### Alternatives considered, deferred
- **Structured attack fields in bestiary frontmatter** (`attackBonus`/`damageDice`) instead of D-04 prose parsing — cleaner data but requires editing every bestiary file; v3.
- **Recompute the monster attack bonus from STR/DEX + proficiency** (true 5e math) instead of parsed/CR-table values — needs monster ability scores in the vault view; v3.
- **PC target = always `cpcId`** — rejected in favor of random-live-PC (D-11); revisit if multi-PC targeting needs tactics (LLM-proposed target) in v3.

None of the above blocks v2 — discussion stayed within the monster-turn-resolution scope.
</deferred>

---

*Phase: 09-v2-monster-turns*
*Context gathered: 2026-05-30 via interactive discuss-phase*
