# Design — Server-Side Combat Resolver v1 (Player Attacks)

**Date:** 2026-05-29
**Status:** Approved (brainstorming) — ready for implementation plan. **Execution deferred to a dedicated session.**
**Phase:** 08-server-side-combat-resolver-v1-player-attacks
**Builds on:** Phase 06 (D1 state), Phase 07 (D2 prompt-driven combat). Groundwork: `docs/superpowers/specs/2026-05-29-server-side-combat-resolver-groundwork.md`.

## Purpose

The D2 smoke proved a hard ceiling: local models (gemma4, qwen3) start combat and
ask for a to-hit roll, but will NOT reliably perform the mechanical resolution —
they free-narrate the outcome (observed: narrated a MISS on a roll of 18 vs AC 14,
ignoring the rolled number), never ask for the separate damage roll, never apply
HP, never advance the turn. The rules sequence is currently the LLM's job (a prompt
directive) and the LLM fails it.

**v1 moves PLAYER-attack resolution server-side.** The turn route deterministically
resolves the to-hit (vs the monster's AC), issues the damage-roll request on a hit,
applies the damage to the monster's HP, and advances the turn. The LLM only
NARRATES the server-determined outcome. The rules are enforced by code, not the model.

**v1 scope boundary:** player attacks resolve mechanically; **monster attacks stay
LLM-narrated** (that is v2 — it needs the PC's AC from Postgres + monster attack
data). In a 1v1 (One Piece vs Veyra): your hits drop Veyra's HP in the tracker, but
Veyra's attacks on you remain narrative until v2.

## 5e rules grounding (what v1 enforces, what it simplifies)

Verified against the baked engine (`src/engine/combat/attack.ts`, PHB-referenced):
- **To-hit:** d20 + attack bonus vs target AC; **natural 20 = auto-hit**, natural 1 = auto-miss. v1 enforces `hit = natural20 || total >= AC`. ✓ faithful.
- **Damage:** a SEPARATE roll after a hit; subtract from HP; 0 HP = down. v1 enforces the separate damage roll + `monster_hp_change`. ✓ faithful (two-step).
- **v1 SIMPLIFICATIONS (documented, refined later):**
  - The player's roll already carries their bonus (the LLM bakes `+3` into `1d20+3`), so v1 compares the rolled TOTAL to AC — it does NOT recompute the attack bonus from a sheet. ✓ correct (the bonus is in the roll).
  - **Damage die is a DEFAULT** (e.g. `1d6`) + the bonus reused from the to-hit roll — NOT the character's real weapon die (custom chars like Luffy have no standard weapon). Real weapon damage = v3.
  - **Crit damage doubling** (nat 20 → double damage dice) is NOT applied in v1 (nat 20 just auto-hits). = v3.
  - **Resistances / immunities / cover / advantage** not modeled in v1. = v3.
  - **Monster turns** (monster attacking a PC) not resolved in v1. = v2.

## Scope decisions (from brainstorming)

- **Server-issued damage request, default formula** (operator chose): on a confirmed
  hit, the SERVER emits `"Tira <defaultDie>+<bonus> danni a <target>"` (bonus reused
  from the to-hit roll). Reliable, no new per-character data, and the player still
  rolls the damage die. (Rejected: LLM-issued damage request — unreliable; auto-roll
  — player doesn't roll.)
- **Two-step driven by the roll label** (stateless): the incoming roll's label +
  dice expression tell the resolver whether it is a to-hit or a damage roll. The
  target is carried in the damage-request label (`danni a <target>`) so the damage
  roll echoes it → the resolver knows whom to damage. No transient "awaiting damage"
  state needed.
- **Narration-only on resolution turns:** the server emits the events, then runs the
  LLM with a "[RESOLVED BY SYSTEM: …] narrate this outcome in 2nd person" directive;
  the LLM's combat-event `apply_event` tool calls are IGNORED that turn (prevents
  double-apply). The LLM colors; the code decides.
- **Defaults:** monster AC absent → `12`; damage die default `1d6`; nat 20 auto-hit.

## Architecture

```
player roll-result during active combat
  → [turn route, BEFORE runVaultToolLoop]
     gate: vaultMutations && encounter.active && isRollResult(playerMessage)
  → resolveCombat({ rollResult, encounter }):
       parse total + natural + dice-kind + label
       ┌ to-hit (1d20, "attaccare X"):  target=X→monster; hit = nat20 || total>=AC(def 12)
       │     miss → { events:[turn_advance], directive:"narrate MISS", damageRequest:null }
       │     hit  → { events:[], directive:"narrate HIT", damageRequest:"Tira 1d6+<bonus> danni a X" }
       └ damage ("danni a X"):          target=X→monster
             → { events:[monster_hp_change(id,-total), turn_advance], directive:"narrate -<total> HP" }
  → emit resolver.events via the existing apply_event dispatch (server-side)
  → run runVaultToolLoop in NARRATION-ONLY mode with resolver.directive
       (combat-event tool calls from the LLM are dropped this turn)
  → if resolver.damageRequest and the LLM output lacks a roll-request → append it (safety net)
```

When the gate does NOT fire (not a roll-result, or no active combat), the turn runs
exactly as today (the Phase 07 prompt-driven path + 07-03 handoff) — unchanged.

## The resolver (`src/app/api/sessions/[id]/turn/combat-resolver.ts`, new)

A pure function — no I/O, unit-testable headless:

```
resolveCombat(input: {
  rollResult: string;              // the player's "🎲 I rolled **N** for ..." message
  encounter: EncounterState;       // active encounter (monsters + turnOrder)
  defaultMonsterAc?: number;       // default 12
  defaultDamageDie?: string;       // default "1d6"
}): {
  kind: 'to-hit' | 'damage' | 'none';
  events: VaultEvent[];            // to emit server-side (monster_hp_change / turn_advance)
  narrationDirective: string;      // "[RESOLVED BY SYSTEM: ...] narrate in 2nd person"
  damageRequest: string | null;    // "Tira 1d6+3 danni a Veyra" on a hit, else null
} | null                           // null → not a combat roll; fall through to normal turn
```

Parsing helpers (reuse / extend):
- Total + natural: from `🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).` → total 18, natural 15 (first number of the breakdown), bonus +3, dice `1d20`.
- Kind: `1d20…` + ("attacc"/"colp") → to-hit; non-d20 + "danni" → damage.
- Target: parse the name after "attaccare"/"danni a" → case-insensitive match to `encounter.monsters[].name` → id + ac.
- Edge: no target match, or ambiguous, or unparseable → return `null` (graceful fall-through to the normal LLM turn; never throw).

## Components

| Unit | Change |
|---|---|
| `src/app/api/sessions/[id]/turn/combat-resolver.ts` (NEW) | the pure `resolveCombat` + parsing helpers |
| `src/app/api/sessions/[id]/turn/route.ts` (vault branch) | hook before `runVaultToolLoop`: read encounter early, gate, call `resolveCombat`, emit events, run narration-only loop with the directive, append the damage request if missing |
| `src/ai/master/vault/turn-directive.ts` | suppress the player-side resolve directive when the server already resolved (avoid conflicting instructions); the server's narration directive takes over |
| `tests/.../combat-resolver.test.ts` (NEW) | headless: hit/miss vs AC, default AC, nat-20 auto-hit, damage→HP, target parsing from label, two-step via label, graceful null on unparseable |

## Testing

1. **Resolver unit (headless, no LLM):** to-hit total ≥ AC → hit + damageRequest; < AC → miss + turn_advance; nat 20 < AC → still hit; damage roll → monster_hp_change(-total) + turn_advance; target parsed from label; unknown target → null; default AC (12) when monster.ac absent; default die in the damage request.
2. **Route integration:** a roll-result during active combat is resolved server-side (events emitted) and the LLM runs narration-only (a combat `apply_event` from the LLM that turn is ignored → no double-apply); the damage request is present after a hit (LLM-included or safety-net-appended). Non-combat turns unchanged (regression).
3. **Operator smoke:** attack Veyra → server confirms hit/miss vs AC (no more arbitrary outcome) → on hit the 🎲 damage button appears → roll damage → Veyra's HP drops in the CombatTracker → turn advances.

## Error handling / edge cases

- **Unparseable / no target / not a combat roll** → `resolveCombat` returns `null` → the turn falls through to the normal LLM path (graceful degradation, never a hard fail).
- **Monster already dead / not in turnOrder** → resolve defensively (skip damage, still advance) — covered by the D1 reducer's defensive guards.
- **Double-apply prevention** → on resolution turns the LLM's combat-event tool calls are dropped (the server already emitted the authoritative events).
- **Player rolls damage with no preceding hit** (out-of-band) → if no live target can be inferred from the label, return `null` (fall through).

## Non-goals (explicit)

- **Monster turns / monster attacks resolving against the PC** → v2 (needs PC AC from Postgres `characters` + monster attack data; the bestiary `actions` are prose).
- **Real weapon damage dice, crit damage doubling, resistances/immunities/cover/advantage** → v3.
- **Auto `combat_end`** when all monsters die → v3 (v1 leaves combat_end to the existing flow).
- No change to the D1 reducer, the CombatTracker, or the event schema (the resolver only EMITS existing events).

## Verification of success

On One Piece (qwen3, combat active): a player attack roll is resolved by the SERVER
(hit/miss vs the monster's AC — the model no longer decides it); on a hit the damage
🎲 button reliably appears; rolling it drops the monster's HP in the tracker and
advances the turn; the LLM narrates the server-determined outcome with no
contradiction. Automated tests verify the resolver math + the no-double-apply
integration + the non-combat regression. (Monster attacks remain narrative — v2.)
