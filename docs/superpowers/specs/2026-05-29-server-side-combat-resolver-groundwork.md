# Groundwork — Server-Side Combat Resolver (vault path)

**Date:** 2026-05-29
**Status:** RESEARCH + DECISIONS captured — NOT yet designed. Ready to brainstorm → spec → GSD in a dedicated session.
**Phase:** 08-server-side-combat-resolver-v1-player-attacks
**Builds on:** Phase 07 (D2 — prompt-driven combat; shipped + green)

> This is pre-design groundwork, not an approved spec. The next session runs the
> normal brainstorming flow with this as input, then writes the spec.

## Why this phase exists (the ceiling we hit)

Phase 07 (D2) made vault combat **start, render, and roll** via prompt directives.
Verified shipped + green:
- Combat starts (intent-aware per-turn directive → `combat_start`/`monster_spawn`/`initiative_set`).
- Tracker populates (reducer auto-activates on the first combat event).
- 🎲 roll button appears (roll-parser tolerates quote chars).
- No re-ask loop (roll-result resolve directive).

But the D2 operator smoke + a direct `qwen3` probe proved a **hard ceiling**: local
models (gemma4 8B, qwen3 30B) handle **narration + intent** but will NOT reliably
perform **deterministic mechanical resolution**. Given a roll-result, the model
free-narrates the outcome (observed: narrated a MISS on a roll of 18 vs AC 14 —
ignoring the rolled number), never applies `monster_hp_change`, never asks for the
damage roll, never `turn_advance`s. Combat is therefore "narrative with a static
tracker" — HP never changes.

**Decision (operator, 2026-05-29):** move the mechanical resolution SERVER-SIDE.
The server resolves (roll → AC → hit/miss → damage → HP → turn), the LLM only
NARRATES the server-determined outcome. The anti-railroading "narrate the outcome"
instinct then becomes correct (the outcome is handed to it, not invented).

## Reusable engine math (do NOT rebuild — reuse/port)

All pure, crypto-RNG-defaulted (`src/engine/rand.ts` `defaultRng` uses `node:crypto`):
- **To-hit:** `src/engine/combat/attack.ts` `makeAttack()` (~:137). Core: `rollD20({advantage,disadvantage,modifier: attackBonus})`; nat 20 = crit (auto-hit), nat 1 = fumble (auto-miss); `hit = naturalCrit || total >= effectiveAc`. Attack bonus: `src/engine/modifiers.ts:60-64` = `abilityModifier(STR|DEX) + (proficient ? profBonus : 0)`.
- **Damage + HP:** `src/engine/combat/damage.ts` `applyDamage()` (~:82) — resistances/immunities/vulnerabilities, temp-HP, 0-HP death/unconscious, death-save failures. (Simpler inline rule `newHp = max(0, hpCurrent + delta)` already lives in the vault `monster_hp_change` reducer.)
- **Dice:** `src/engine/dice.ts` — `rollDice(formula)`, `rollD20({advantage,disadvantage,modifier})`, `rollDamage(formula, {crit})` (crit doubles dice). Parses `NdM±K`.

## Vault hook point

`src/app/api/sessions/[id]/turn/route.ts` (vault branch):
- Player message → `body.message` (~:97), persisted (~:205-211), latest text → `_playerMessage` (~:355-357).
- Active encounter currently read POST-LLM (~:454-455): `parseEventsFile(eventsPath(campaignId))` → `replayEvents()` → `{ encounter }` (feeds 07-03 `resolveCombatHandoff`).
- **Resolver hook:** run BEFORE `runVaultToolLoop` (~:379). Move/duplicate the encounter read up to ~:357, gate on `vaultMutationsEnabled && encounter.active && isRollResult(_playerMessage)`. Resolve → emit `apply_event` mutations server-side → then run the loop narration-only (pass the LLM a "narrate THIS outcome" directive).
- Roll-result format (built in `src/components/game/roll-request-button.tsx:128,133`): `🎲 I rolled **<total>** for <label> (<dice><mod>).` `isRollResult()` already exists (`src/ai/master/vault/turn-directive.ts:67`).
- **Kind** (to-hit vs damage): infer from the dice expr (`1d20…` → to-hit; non-d20 `XdY…` → damage) and/or label keywords (`attaccare`/`danni`).
- **Target (WHO):** parse the name from the label tail `(attaccare Veyra)` → match `EncounterState.monsters[].name` → get the monster `id` (the label carries only the NAME, not the id).

## The data wrinkle (the real design problem)

- **Monster AC** is OPTIONAL in `EncounterState.monsters[].ac?` (projector.ts:671; many spawns omit it). Resolver needs a **default AC** fallback.
- **PC AC + attack/damage stats are NOT in the vault view.** `characters/<slug>.md` frontmatter has only `hp_current/hp_max/conditions/spell_slots/inventory` (and `CharacterState` carries no `ac`/`abilities`). PC combat stats live in **Postgres `characters`** (`src/db/schema/characters.ts`: `ac:38`, `abilities:35`, `proficiencyBonus:36`, `proficiencies:40-45`, `inventory/features:77-78`). The route already queries the party (~:434-442) — extend the select to pull `ac`/`abilities`/`proficiencyBonus`.
- **Custom characters** (Luffy's "Gum Gum", not a standard weapon) have no clean weapon damage formula → auto-rolling PC damage server-side is fuzzy.

## The simplifying insight (makes v1 clean)

The player's rolled **total already includes their bonus** (the LLM bakes the `+3`
into `1d20+3` from the sheet). So for **player attacks**, the resolver needs NO PC
stats: compare the rolled total to the monster's AC, and apply the player's
(manual) damage-roll total to the monster's HP. The PC-stats Postgres bridge is
only needed for **monster turns** (a monster attacking a PC needs the PC's AC).

## Proposed decomposition

| Sub-phase | Scope | Data needed |
|---|---|---|
| **v1 — player attacks (THIS phase)** | roll-result during combat → kind+target from label → to-hit total vs monster AC (+default) → hit/miss → on hit ask for damage roll → apply `monster_hp_change` → `turn_advance`; LLM narrates server outcome | only monster AC — clean, no PC-stats bridge |
| **v2 — monster turns** | on a monster's turn, server auto-rolls the monster's attack vs the PC's AC (Postgres bridge) + damage → PC HP | PC AC (Postgres) + monster attack data (bestiary "actions" is prose, not structured) |
| **v3 — polish** | conditions, multi-attack, fleeing/`combat_end` auto-detect, crit/resistances | — |

## Open decisions for the design session

1. **Damage roll: manual vs auto.** Manual (player rolls damage too — consistent UX, sidesteps the custom-char damage-formula problem since the LLM/player provides the formula) vs auto (server rolls — one player roll per attack, but needs a PC damage formula). Leaning **manual** for v1 (clean + consistent).
2. **Default monster AC** when `ac` is absent at spawn (e.g. 12? or by CR?). Also: should the combat-lifecycle prompt push the model to always include `ac` in `monster_spawn`?
3. **Narration handoff shape.** How the resolver passes the server-determined outcome to the LLM to narrate (a structured directive appended to history? a synthetic system note? the existing per-turn-directive mechanism?).
4. **How the resolver asks for the damage roll on a hit.** The resolver is server-side; the damage-roll request (`Tira <dmg> danni`) must reach the client as a 🎲 button. Does the resolver emit it as the master message, or instruct the LLM to (the thing the LLM was unreliable at)? Likely the resolver produces it deterministically.
5. **v2 monster attack data.** The bestiary stat blocks have `actions` as PROSE (e.g. "Scimitar +4 (1d6+2)"). Monster auto-attacks (v2) need structured attack bonus + damage — parse the prose, or add structured fields to the bestiary frontmatter, or default.
6. **Attack→damage two-step turn flow** across messages (attack roll resolves → damage roll request → damage roll resolves → HP applied → turn advances): how the resolver tracks "awaiting damage roll" state between turns (a transient flag in the encounter? infer from the last roll?).

## What's already in place (reuse)

- `EncounterState` + `combat.md` + snapshot wiring (D1/Phase 06) — the tracker renders from it.
- The 6 encounter events + `apply_event` dispatch (Phase 07) — the resolver emits these.
- `isRollResult` / `detectCombatIntent` / the per-turn directive (Phase 07) — the resolver coordinates with these (e.g. suppress the LLM "resolve" directive when the server already resolved).
- 07-03 `resolveCombatHandoff` (turnOrder-driven handoff) — the resolver advances the turn, then handoff applies.

---

*Captured 2026-05-29 at the end of a long Phase-04→07 session. Next: brainstorm v1 from this groundwork.*
