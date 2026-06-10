# 2026-06-10 audit — remaining work

Multi-agent audit (9 areas, adversarial verification) of D&D 5e rules
compliance, model configuration, and logical consistency. Raw findings in
`2026-06-10-confirmed.json` / `2026-06-10-unverified.json` (the unverified
file holds findings whose verifier agents were cut off by a session limit —
treat as "reported, verify while fixing", several were since hand-verified).

## Fixed in this pass (commits 305ab22..ca36acd)

1. `305ab22` — isSmallModel regex un-capped the validated primary
   (num_predict 2048 → 4096); spike sampling (repeat_penalty 1.13 etc.)
   applied at runtime; NUM_CTX default 16384; KEEP_ALIVE 30m.
2. `ad1eb81` — validated-model governance: whitelist wired into the Settings
   dropdown AND validateSettingsPatch (gemma4/llama no longer selectable);
   `envDefaultMasterModel('local')` never returns ''.
3. `0d4058c` — turn directive reconciled with the tool surface: begin turn no
   longer trips detectCombatIntent; narrationOnly directives never order
   apply_event; empty-narration retry gated on toolCallCount===0 (double-apply
   guard); end_turn{} no longer wipes narration; stripLeakedMechanics also on
   encounter-inactive turns.
4. `0cbd96e` — apply_event LLM surface: campaign_initialized rejected (genesis
   is server-side only); payload.character checked against the replayed
   roster BEFORE append (no more permanent zombie events).
5. `42414c7` — RAW attack math on the vault path: pc-attack-profile (weapon
   dice + ability-only damage mod, sheet-derived to-hit), crit doubling on
   nat-20 (player AND monster), PC initiative adds DEX mod.
6. `8c2c2fc` — Action Surge recharges on short rest (rules.md §14); Bardic
   Inspiration short-rest recharge gated to level 5+.
7. `ca36acd` — vault hp_change implements the RAW damage pipeline (temp-HP
   absorption, unconscious/dying at 0, massive-damage instant death,
   damage-at-0 death-save failures, wake-on-heal) on BOTH legs.

## Remaining — prioritized

### P1 · Progression (frozen at level 1)

Both auditors converged on this cluster; player-visible from level 2 on.

- Caster spell slots never progress: `levelUp()` never re-derives slotsMax
  (the correct table in `src/engine/multiclass.ts` is dead code).
- `hit_dice_max` never updated on level-up (pool frozen; legacy seeds carry 0).
- Multiclass level grants no HP, no hit die, stale proficiency bonus — and
  blocks the level_up tool afterwards.
- Spell save DC / spell attack frozen at character creation.
- Warlock Pact Magic slots: no short-rest recovery, no level progression
  (rules.md §14 lists them as short-rest).
- Level-up HP roll not clamped to min 1/level.
- `level_up` tool enforces no XP threshold (LLM can level at will).
- Arcane Recovery recharges on EVERY short rest (RAW once/day — needs a
  daily-use flag in runtime state).

### P2 · Spellcasting resolution

- `cast_spell` tool strips target AC → every attack-roll spell errors out
  (the engine cannot resolve attack spells at all).
- Save spells apply FULL damage before the save; the heal-refund protocol
  cannot undo deaths/death-save failures/concentration breaks. Resolve the
  save BEFORE applying damage.
- Concentration not tracked for unbound spells (spellMeta.concentration
  fetched but ignored) while the prompt forbids manual tracking.
- Binding content errors: Faerie Fire applies a defensive buff to enemies
  that FAIL; Sleep invents a WIS save (RAW: 5d8 HP pool, no save);
  Disintegrate marked halfOnSuccess (RAW: negates); Scorching Ray one beam
  instead of three; multi-beam cantrips as one big roll; several bindings
  missing a damage component; inconsistent duration units (one 10×); latent
  crit bug would double flat modifiers.
- 33 SPELL_BINDINGS keys unreachable (PHB-name slugs vs SRD CSV slugs;
  some SRD spells missing from spells.csv — e.g. Cone of Cold).
- Prepared-caster rule unenforced; ritual casting has no class gate and
  free upcast.

### P3 · Conditions & checks plumbing

- Condition speed/HP-max effects computed but consumed by NO code path
  (grappled/restrained can walk; exhaustion 2/4/5 inert).
- `apply_condition` can never target the PLAYER character (baked path).
- Unconscious does not imply the prone-style ranged-attack rules.
- Contested/group checks and forced-march/dehydration saves bypass
  condition effects (raw d20 instead of savingThrow()).
- `recomputeAC` ignores its armorSpecs param outside a 13-slug catalog.

### P4 · Engine features wired but unreachable

Opportunity attacks (baked), Sneak Attack, Extra Attack (Loading bypass),
range bands / ranged-in-melee disadvantage, resistance+vulnerability same
type, Help 5-ft constraint, `set_temp_hp` ignoring actorId, no deterministic
combat termination on the ENGINE (baked) path.

### P5 · State consistency (dual-write era)

Mostly moot after cutover (vault becomes sole source of truth), fix only if
the dual-write soak is extended: no event-id idempotency (retry
double-apply), server-resolved events skip the PG leg, parity-check
normalizes with stale hardcoded defaults (false positives), per-session
session_state row misroutes multi-PC events, monster over-heal unclamped,
non-integer deltas accepted, divergent death-save semantics across legs
(vault leg now RAW — align or retire the others), corrupt events.md line
silently falls back to stale Postgres. Attunement cap (3) unenforced.
Also: the vault path runs extractMemory every turn but nothing consumes the
output (wasted M4 latency).

### P6 · Prompt alignment

- Vault system prompt still carries the stale Phase-07 combat-lifecycle
  block (tells the model to manage combat it no longer owns).
- EN campaigns cannot resolve combat: resolver/directives are Italian-only.
- Compact DM handbook: wrong death-save rule ("Crit on death save = +2
  successes" — RAW: nat 20 regains 1 HP; crit damage while down = 2 fails).
- Three inconsistent XP-award scales across prompt blocks; starvation days
  formula mismatch; currency §5.2 citation (is §9.2); fireball used as a
  concentration example; crafting formula ~20× off; exploration block
  instructs set_travel_pace with pace=null (schema rejects); baked SLIM
  contract references tools the surface doesn't expose; legacy non-baked
  path overflows 16k ctx (~25K static tokens).

### Operational notes

- **Model governance reverted at operator request (2026-06-10):** the
  validated-model allowlist is no longer enforced — any installed Ollama
  model is selectable in Settings and used as stored. Non-validated models
  carry a non-blocking UI warning and run narration-only via the weak-tool
  gate (the server still owns combat). The `matchesLlmWhitelist` helper now
  only drives that warning. If you want to re-tighten, re-wire it into
  `fetchOllamaModels` / `validateSettingsPatch` / `resolveLocalMasterModel`.
- `scripts/build-local-models.ts` executes main() on import (unhandled
  rejection during vitest runs) — wrap in `if (require.main)`-equivalent.
- Verify on the M4 that NUM_CTX 16384 + sampling changes hold the <10s warm
  target (spike validation was pre-sampling-options).
