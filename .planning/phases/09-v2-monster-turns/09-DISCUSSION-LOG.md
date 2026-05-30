# Phase 09: v2 Monster Turns - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-30
**Phase:** 09-v2-monster-turns
**Areas discussed:** Monster attack data source, Monster-turn loop, PC target selection, Monster roll rules, PC-at-0-HP, Multi-turn narration, Loop stop conditions, Custom-monster scaling

---

## Area selection (which to discuss)

Multi-select of 4 candidate gray areas. **User selected all 4:** Dati attacco mostro, Loop turni mostro, Bersaglio PC, Regole tiro mostro.

---

## Monster-turn loop (trigger & flow)

| Option | Description | Selected |
|--------|-------------|----------|
| Generale, stesso request | Trigger "active actor = monster"; loop server-side in same request until PC turn, then 07-03 handoff | ✓ |
| Solo dopo attacco player | Resolve monster turns only right after a player attack | |
| Trigger separato (client ping) | Client detects monster turn and pings the server | |

**User's choice:** Generale, stesso request (recommended). → CONTEXT D-01/D-02.

---

## Monster roll rules (crit/nat + auto-roll)

| Option | Description | Selected |
|--------|-------------|----------|
| Mirror v1 | nat20 auto-hit, nat1 auto-miss, no crit-doubling; server auto-rolls; injectable RNG seam | ✓ |
| Crit 5e completo | nat20 doubles damage dice already in v2 | |
| Niente nat speciali | Only total ≥ AC, no nat20/nat1 specials | |

**User's choice:** Mirror v1 (recommended). → CONTEXT D-09/D-10. Confirmed against `rules.md §3.10` + handbook §4 during the rulebook check.

---

## PC target selection

| Option | Description | Selected |
|--------|-------------|----------|
| PC corrente / cpcId | Monster attacks `currentPlayerCharacterId` — deterministic, trivial for 1v1 | |
| PC vivo a caso (RNG) | Server picks a random live PC; RNG already on the table for dice | ✓ |
| Il LLM propone, server valida | LLM suggests target by name, server matches a live PC | |

**User's choice:** PC vivo a caso (RNG) — **diverged from the cpcId recommendation.** → CONTEXT D-11. Drawn from the same injected RNG seam (D-10); collapses to the single PC in the 1v1 smoke.

---

## Monster attack data source (round 1)

| Option | Description | Selected |
|--------|-------------|----------|
| Default per tutti | Fixed defaults for every monster, no lookup | (initial) |
| Parse prosa bestiario | Regex the bestiary `## Actions` prose + default fallback | |
| Frontmatter strutturato | Add structured attack fields to bestiary frontmatter | |

**User's choice (round 1):** Default per tutti — **then reconsidered:** *"aspetta, forse mi sono sbagliato sulla scelta. Controlla il regolamento del master se ci sono informazioni in merito."*
**Notes:** Triggered a rulebook investigation (`master_handbook.md`, `master_handbook_compact.md`, `rules.md`). Findings: no flat monster-attack default in the rules; the "Improvising Damage" table (§8.2) is environmental-only; but §8 ("reskin existing stat blocks") + §7.6 ("monsters aren't just HP and AC") favor using REAL stat blocks. Re-asked the area with that context.

## Monster attack data source (round 2 — post-rulebook)

| Option | Description | Selected |
|--------|-------------|----------|
| Parse bestiario + fallback | Real stats for bestiary monsters; default for custom | |
| Default per tutti | Flat default, ignores real stat blocks | |
| Frontmatter strutturato + fallback | Structured frontmatter + default | |

**User's choice (round 2, free-text):** *"Il server utilizza i mostri dal bestiario, ma in caso di mostri custom come Veyra decide automaticamente le statistiche in base alla situazione. Ad esempio, se è il boss finale della campagna, ovviamente lo farà più forte rispetto al caso in cui crea un mostro secondario all'inizio."*
**Notes:** → bestiary monster = real parsed stats (D-04); custom monster = situation-scaled (boss > minion), not a flat default. Led to the scaling-mechanism question below.

---

## Default fallback values

| Option | Description | Selected |
|--------|-------------|----------|
| +4 / 1d6 | Symmetric with v1 defaults, goblin-tier, forgiving | ✓ |
| +5 / 1d8 | More threatening (~CR 1-2) | |
| +3 / 1d4 | Softer, for testing the loop | |

**User's choice:** +4 / 1d6 (recommended) — the floor for the weakest custom monster. → CONTEXT D-06.

---

## Custom-monster scaling mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Tier su hpMax | Derive attack/damage from spawned `hpMax` tiers | |
| Tier su CA | Scale on `ac` (optional, defense not offense) | |
| Il LLM suggerisce il tier | LLM provides a tier/CR hint in `monster_spawn`; server maps deterministically | ✓ |

**User's choice:** Il LLM suggerisce il tier — **diverged from the hpMax recommendation.** → CONTEXT D-05/D-08.
**Notes:** Accepted with the explicit caveat that it adds an ADDITIVE event-schema field (`cr?`) — a conscious deviation from v1's "no schema change." Rationale endorsed: choosing a difficulty is a narrative judgment (LLM strength); the server still owns all mechanics. Field `cr` vs `tier` enum left as a planning-time discretion call (lean `cr`).

---

## PC at 0 HP

| Option | Description | Selected |
|--------|-------------|----------|
| Solo hp_change, clamp 0 | Apply damage; defer downed/death-save/game-over | |
| Marca KO + ferma il loop | Apply damage; if last live PC falls, stop the loop and narrate party KO | ✓ |
| Death-save base in v2 | Bring forward death-save mechanics | |

**User's choice:** Marca KO + ferma il loop — **diverged from the minimal recommendation.** → CONTEXT D-14 (+ stop condition D-03b). Real death saves / game-over still deferred to v3.

---

## Multi-turn narration

| Option | Description | Selected |
|--------|-------------|----------|
| Una narrazione unica | One directive lists all monster outcomes → 1 LLM call | ✓ |
| Una narrazione per mostro | One LLM call per monster turn | |

**User's choice:** Una narrazione unica (recommended) — best for Mac Mini M4 latency. → CONTEXT D-15.

---

## Loop stop conditions

| Option | Description | Selected |
|--------|-------------|----------|
| Stop + cap, no auto combat_end | Stop on live-PC / no-target / safety cap; no auto combat_end | ✓ |
| Aggiungi auto combat_end PC-side | Emit combat_end when all PCs fall | |
| Solo 'PC vivo' + cap | No explicit no-target stop | |

**User's choice:** Stop + cap, no auto combat_end (recommended). → CONTEXT D-03. Auto `combat_end` deferred to v3.

---

## Claude's Discretion

- Difficulty-hint field: `cr` (lean) vs a coarse `tier` enum.
- The exact difficulty→(attackBonus, damageDice) mapping table.
- The bestiary-prose regex for `+N to hit` / `XdY±Z`.
- Exact base-default formula beyond +4/1d6.
- The safety iteration cap value.
- New file vs extend `combat-resolver.ts`; exact route hook point; D-16 suppression mechanism; narration wording.

## Deferred Ideas

- v3 polish: crit-doubling, resistances/immunities/cover/advantage, multiattack, real death saves + game-over, auto `combat_end`, conditions.
- Structured attack fields in bestiary frontmatter (alt to prose parsing).
- Recompute monster attack bonus from STR/DEX + proficiency (true 5e math).
- Multi-PC tactical targeting (LLM-proposed) — v2 uses random-live-PC.
