# Phase 08: Server-Side Combat Resolver (v1 Player Attacks) - Context

**Gathered:** 2026-05-29
**Status:** Ready for planning
**Source:** PRD Express Path (`docs/superpowers/specs/2026-05-29-combat-resolver-v1-design.md`)

<domain>
## Phase Boundary

Move **PLAYER-attack mechanical resolution server-side**. Today the rules sequence
is the LLM's job (a prompt directive) and local models (gemma4, qwen3) fail it: they
free-narrate outcomes (observed: narrated a MISS on a roll of 18 vs AC 14), never
ask for the damage roll, never apply HP, never advance the turn.

v1 makes the turn route deterministically resolve the to-hit (vs the monster's AC),
issue the damage-roll request on a hit, apply the damage to the monster's HP, and
advance the turn. **The LLM only NARRATES the server-determined outcome.** Rules are
enforced by code, not the model.

**v1 scope boundary (LOCKED):** player attacks resolve mechanically; **monster
attacks stay LLM-narrated** (that is v2 — it needs the PC's AC from Postgres +
monster attack data). In a 1v1 (One Piece vs Veyra): your hits drop Veyra's HP in
the tracker, but Veyra's attacks on you remain narrative until v2.

**No change** to the D1 reducer, the `CombatTracker`, or the event schema — the
resolver only EMITS existing events (`monster_hp_change`, `turn_advance`).
</domain>

<decisions>
## Implementation Decisions

Everything in the approved spec is a LOCKED decision.

### D-01 — Resolver gate + hook point (LOCKED)
- New pure function `resolveCombat` in
  `src/app/api/sessions/[id]/turn/combat-resolver.ts` (NEW). No I/O,
  unit-testable headless.
- Hook in the turn route **BEFORE** `runVaultToolLoop` (~route.ts:379). Move/duplicate
  the encounter read up to ~:357 (currently read POST-LLM at ~:454-455).
- Gate: `vaultMutations && encounter.active && isRollResult(playerMessage)`.
- When the gate does **NOT** fire (not a roll-result, or no active combat), the turn
  runs **exactly as today** (Phase 07 prompt-driven path + 07-03 handoff) — unchanged.

### D-02 — `resolveCombat` signature + return contract (LOCKED)
```
resolveCombat(input: {
  rollResult: string;          // the player's "🎲 I rolled **N** for ..." message
  encounter: EncounterState;   // active encounter (monsters + turnOrder)
  defaultMonsterAc?: number;   // default 12
  defaultDamageDie?: string;   // default "1d6"
}): {
  kind: 'to-hit' | 'damage' | 'none';
  events: VaultEvent[];          // monster_hp_change / turn_advance — emitted server-side
  narrationDirective: string;    // "[RESOLVED BY SYSTEM: ...] narrate in 2nd person"
  damageRequest: string | null;  // "Tira 1d6+3 danni a Veyra" on a hit, else null
} | null                         // null → not a combat roll; fall through to normal turn
```

### D-03 — To-hit resolution (LOCKED — 5e faithful)
- Kind detection: `1d20…` dice expr + label keyword (`attacc`/`colp`) → to-hit.
- Target: parse the name after `attaccare`/`colpire` → **case-insensitive** match to
  `encounter.monsters[].name` → resolve monster `id` + `ac`.
- Hit rule enforced: **`hit = natural20 || total >= AC`** (default AC 12 when
  `monster.ac` absent). Natural 20 = auto-hit. (Mirrors `makeAttack`'s rule; the d20
  is already rolled client-side, so the resolver compares the rolled TOTAL — it does
  NOT recompute the bonus from a sheet.)
- **Miss** → `{ kind:'to-hit', events:[turn_advance], directive:"narrate MISS", damageRequest:null }`.
- **Hit** → `{ kind:'to-hit', events:[], directive:"narrate HIT", damageRequest:"Tira <defaultDie>+<bonus> danni a <target>" }`
  (bonus reused from the to-hit roll; turn does NOT advance yet — it advances after the damage roll).

### D-04 — Damage resolution (LOCKED — two-step, stateless via label)
- Kind detection: non-`d20` dice expr + label keyword `danni` → damage.
- Target: parse the name after `danni a` → match to a monster → id.
- → `{ kind:'damage', events:[monster_hp_change(id, -total), turn_advance], directive:"narrate -<total> HP" }`.
- **Stateless two-step:** the incoming roll's label + dice expr tell the resolver
  whether it is a to-hit or a damage roll. The target is carried in the
  damage-request label (`danni a <target>`) so the damage roll echoes it → the
  resolver knows whom to damage. **No transient "awaiting damage" state is needed.**

### D-05 — Parsing helpers (LOCKED)
- Total + natural + bonus + dice from the roll-result string. Example:
  `🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).`
  → total `18`, natural `15` (first number of the breakdown), bonus `+3`, dice `1d20`.
- Reuse `isRollResult` (already at `turn-directive.ts:67`); reuse the roll-result
  format produced at `roll-request-button.tsx:128,133`.
- **Edge → return `null`** (graceful fall-through to the normal LLM turn, never throw):
  no target match, ambiguous target, unparseable roll, or not a combat roll.

### D-06 — Server-side emission + narration-only loop (LOCKED)
- Emit `resolver.events` via the existing `apply_event` dispatch (server-side).
- Run `runVaultToolLoop` in **NARRATION-ONLY mode** with `resolver.narrationDirective`:
  the LLM's combat-event `apply_event` tool calls are **DROPPED that turn** (prevents
  double-apply — the server already emitted the authoritative events). The LLM colors;
  the code decides.
- Directive form: `[RESOLVED BY SYSTEM: …] narrate this outcome in 2nd person`.
- **Safety net:** if `resolver.damageRequest` is set and the LLM output lacks a
  roll-request → append the damage request so the 🎲 button reliably appears.

### D-07 — Player-side directive suppression (LOCKED)
- `src/ai/master/vault/turn-directive.ts`: suppress the player-side "resolve" directive
  (the 07-05 re-ask-breaker) when the server already resolved — avoid conflicting
  instructions; the server's narration directive takes over that turn.

### D-08 — Defaults (LOCKED)
- Monster AC absent → **12**. Damage die default → **`1d6`**. Natural 20 → auto-hit.

### D-09 — v1 simplifications (LOCKED — documented, refined later)
- Compare the rolled TOTAL to AC — do NOT recompute the attack bonus from a sheet
  (the bonus is already baked into the roll). ✓ correct.
- Damage die is the DEFAULT (`1d6`) + the bonus reused from the to-hit roll — NOT the
  character's real weapon die (custom chars like Luffy have no standard weapon). Real
  weapon damage = v3.
- Crit damage doubling (nat 20 → double damage dice) is NOT applied in v1 (nat 20 just
  auto-hits). = v3.
- Resistances / immunities / cover / advantage NOT modeled in v1. = v3.
- Monster turns (monster attacking a PC) NOT resolved in v1. = v2.

### D-10 — Edge cases (LOCKED — resolve defensively, never hard-fail)
- Monster already dead / not in `turnOrder` → resolve defensively (skip damage, still
  advance) — covered by the D1 reducer's defensive guards.
- Player rolls damage with no live target inferable from the label → return `null`
  (fall through to the normal turn).
- Non-combat turns and unparseable rolls → `null` → normal LLM path (regression-protected).

### Claude's Discretion
- Exact wording of the narration directive (semantics LOCKED: hit/miss/-HP, 2nd person).
- How NARRATION-ONLY mode is implemented inside `runVaultToolLoop` (drop combat-event
  `apply_event` calls for the resolved turn).
- The precise parsing-helper structure and regexes (as long as the example in D-05
  parses correctly and edges return `null`).
- How the encounter read is moved/duplicated up the route (as long as the non-combat
  path is unchanged and the POST-LLM 07-03 handoff still works).
- The exact safety-net append mechanism for the damage request.
- Test file location/organization and whether `nat 1 → auto-miss` gets an explicit
  branch beyond the `total >= AC` formula (the spec enforces `hit = nat20 || total >= AC`).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec
- `docs/superpowers/specs/2026-05-29-combat-resolver-v1-design.md` — the approved design (this CONTEXT derives from it; includes the architecture diagram + the resolver contract + the testing plan).
- `docs/superpowers/specs/2026-05-29-server-side-combat-resolver-groundwork.md` — groundwork: reusable engine math `file:line`s, the vault hook point, the data wrinkle (monster AC optional, PC stats in Postgres), and the open decisions the spec resolved.
- `.planning/phases/06-vault-combat-state-foundation-d1/06-CONTEXT.md` — D1 decisions (EncounterState shape, the 6 events, `combat.md`, snapshot wiring).
- `.planning/phases/07-vault-combat-playable-d2/07-CONTEXT.md` + `07-03-SUMMARY.md` + `07-05` plans — what D2 built (turnOrder-driven handoff `resolveCombatHandoff`, the roll-result resolve directive, the roll-parser tolerance).

### Code to modify
- `src/app/api/sessions/[id]/turn/combat-resolver.ts` (**NEW**) — the pure `resolveCombat` + parsing helpers (D-02..D-05).
- `src/app/api/sessions/[id]/turn/route.ts` (vault branch) — hook before `runVaultToolLoop` (~:379): read the encounter early (~:357 instead of POST-LLM ~:454-455), gate (D-01), call `resolveCombat`, emit events, run the narration-only loop with the directive, append the damage request if missing (D-06).
- `src/ai/master/vault/turn-directive.ts` — suppress the player-side resolve directive when the server already resolved (D-07); `isRollResult` lives here (~:67) — reuse it.

### Reference (do NOT modify — pattern/contract source)
- `src/engine/combat/attack.ts` `makeAttack()` (~:137) — the hit rule v1 mirrors (`nat20` auto-hit; `hit = nat20 || total >= effectiveAc`). v1 does NOT call it (the d20 is rolled client-side) — it replicates the rule on the rolled total.
- `src/engine/combat/damage.ts` `applyDamage()` (~:82) — full damage/HP rules (resistances etc. are v3); v1 reuses the vault `monster_hp_change` reducer's inline `newHp = max(0, hpCurrent + delta)`.
- `src/engine/dice.ts` — `rollDice`/`rollD20`/`rollDamage`; `NdM±K` parsing (reference for parsing the roll-result breakdown).
- `src/engine/modifiers.ts:60-64` — the attack-bonus formula (`abilityModifier(STR|DEX) + prof`). NOT used in v1 — documents WHY total-vs-AC is correct (the bonus is in the roll).
- `src/ai/master/vault/events-schema.ts` — `monster_hp_change` + `turn_advance` payload shapes (the resolver emits these via `apply_event`).
- `src/ai/master/vault/projector.ts` — `EncounterState` shape: `monsters[].name` / `.id` / `.ac?` (optional → default 12, ~:671); `turnOrder`.
- `src/components/game/roll-request-button.tsx:128,133` — the roll-result format the resolver parses and the damage-request format it emits (`🎲 I rolled **<total>** for <label> (<dice><mod>).`).
- `src/app/api/sessions/[id]/turn/route.ts` POST-LLM encounter read (~:454-455): `parseEventsFile(eventsPath(campaignId))` → `replayEvents()` → `{ encounter }` (the read to move up; still feeds the 07-03 handoff).
</canonical_refs>

<specifics>
## Specific Ideas

- Roll-result example (to-hit): `🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).`
  → total 18, natural 15, bonus +3, dice 1d20, target "Veyra".
- Damage-request format the server emits on a hit: `Tira 1d6+3 danni a Veyra`
  (bonus reused from the to-hit; target name echoed → enables the stateless two-step).
- 1v1 example (One Piece vs Veyra, qwen3): the player's hits drop Veyra's HP in the
  `CombatTracker`; Veyra's attacks on the PC remain narrative until v2.
- **Testing (3 layers, same automated-vs-smoke split as prior phases):**
  1. **Resolver unit (headless, no LLM):** to-hit total ≥ AC → hit + damageRequest;
     < AC → miss + turn_advance; nat 20 < AC → still hit; damage roll →
     `monster_hp_change(-total)` + turn_advance; target parsed from label; unknown
     target → `null`; default AC (12) when `monster.ac` absent; default die in the
     damage request.
  2. **Route integration:** a roll-result during active combat is resolved server-side
     (events emitted) and the LLM runs narration-only (a combat `apply_event` from the
     LLM that turn is ignored → no double-apply); the damage request is present after a
     hit (LLM-included or safety-net-appended); **non-combat turns unchanged (regression).**
  3. **Operator smoke (One Piece, qwen3):** attack Veyra → server confirms hit/miss vs
     AC (no more arbitrary outcome) → on hit the 🎲 damage button appears → roll damage
     → Veyra's HP drops in the tracker → turn advances; narration matches mechanics.
</specifics>

<deferred>
## Deferred Ideas

- **v2 — monster turns / monster attacks vs the PC**: needs the PC's AC from Postgres
  `characters` (`ac`/`abilities`/`proficiencyBonus`) + monster attack data (bestiary
  `actions` is prose, not structured).
- **v3 — combat polish**: real weapon damage dice, crit damage doubling (nat 20 →
  double dice), resistances/immunities/cover/advantage.
- **v3 — auto `combat_end`** when all monsters die (v1 leaves `combat_end` to the
  existing flow).
- No change to the D1 reducer, the `CombatTracker`, or the event schema (v1 only emits
  existing events).

</deferred>

---

*Phase: 08-server-side-combat-resolver-v1-player-attacks*
*Context gathered: 2026-05-29 via PRD Express Path*
