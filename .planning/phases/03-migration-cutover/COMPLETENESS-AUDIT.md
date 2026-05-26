# Phase 03 — Mutation Event Completeness Audit

**Phase:** 03-migration-cutover
**Plan:** 03-A-01 (GATING pre-task — output drives 03-A-02 + 03-A-03 + 03-A-09)
**Date:** 2026-05-26
**Author:** executor (gsd Phase 03 Wave 1)

## Purpose

Phase 02 ships 8 event types in `VAULT_EVENT_TYPES` (`hp_change`, `condition_add`, `condition_remove`, `spell_slot_use`, `spell_slot_restore`, `inventory_add`, `inventory_remove`, `campaign_initialized`). The engine handlers in `src/engine/tools/handlers.ts` ship 61 mutation-emitting entries in `TOOL_HANDLERS` plus 5 entries in `TOOL_HANDLERS_DB` (66 total). Many handlers mutate persisted `session_state` / `characters` columns through mutation `op` types that have **no Phase 02 vault event counterpart**.

If dual-write activates without closing the gap, every combat turn that triggers an uncovered handler will write to Postgres but NOT to events.md → parity-check fires divergence → divergence rate ≈100% on combat turns (RESEARCH Pitfall 1).

This audit classifies every `TOOL_HANDLERS` + `TOOL_HANDLERS_DB` entry as:

- **(a) Already covered** — the handler's persisted mutation maps to an existing Phase 02 event type (e.g., `apply_damage` → `hp_change` with negative delta).
- **(b) Stateless** — the handler doesn't mutate persisted `session_state` / `characters` columns (e.g., `roll_dice` emits dice rolls only; `check_vision` is pure derivation).
- **(c) Needs a new event type** — the handler mutates persisted state in a way no Phase 02 event captures.

The audit is the input to plan 03-A-02 (extend `events-schema.ts` with the (c) list) and plan 03-A-03 (extend `projector.ts` with reducer arms + new `INITIAL_CHARACTER_STATE` fields).

## Methodology

Source: `src/engine/tools/handlers.ts` at HEAD on branch `main`. Each handler key inspected for its emitted `mutations: [{ op: '...', ... }]` array — both directly in the handler body and indirectly via the engine modules it delegates to (`combat/attack.ts`, `combat/damage.ts`, `combat/movement.ts`, `combat/turn.ts`, `combat/initiative.ts`, `combat/standard-actions.ts`, `rests.ts`, `levelup.ts`, `resources.ts`, `conditions.ts`, `equipment.ts`, `checks.ts`, `spells.ts`, `spells/concentration.ts`).

Each emitted `op` cross-referenced against `applyOne()` in `src/sessions/applicator.ts` (lines 153–1491) to determine which Postgres column(s) it writes to. Then compared against the Phase 02 event union in `src/ai/master/vault/events-schema.ts` and the projector state in `src/ai/master/vault/projector.ts`.

**Source files inspected (read-only):**

- `src/engine/tools/handlers.ts` (3383 lines — TOOL_HANDLERS + TOOL_HANDLERS_DB + 30 helper handler functions)
- `src/sessions/applicator.ts` (1784 lines — `applyOne()` switch over 60+ mutation ops)
- `src/db/schema/session-state.ts` (the persisted SessionState columns)
- `src/db/schema/characters.ts` (the Character row)
- `src/db/schema/campaigns.ts` (`tonalFrame`, `engagementProfile` columns — campaign-scoped state)
- `src/ai/master/vault/events-schema.ts` (8 existing event types)
- `src/ai/master/vault/projector.ts` (CharacterState shape + reducer)
- `src/engine/types.ts` (Mutation discriminated union — authoritative list of 46+ op kinds)
- `src/engine/combat/*.ts`, `src/engine/rests.ts`, `src/engine/levelup.ts`, `src/engine/resources.ts`, `src/engine/conditions.ts`, `src/engine/equipment.ts`, `src/engine/checks.ts`, `src/engine/spells.ts`, `src/engine/spells/concentration.ts` (downstream emitters)

**Caveat — repo state:** `src/engine/tools/handlers.ts` contains UNRESOLVED Git merge conflict markers at lines 942, 2277, 3186, 3196, 3213, 3375, 3379 (`<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes`). The audit treats both sides as the union of handlers (TOOL_HANDLERS_DB has 5 entries on the upstream side: `lookup_codex`, `add_narrative_item`, `long_rest`, `cast_spell`, `set_current_player`; plus `add_item` and `recompute_ac` in the stashed-changes block). **The merge conflict is OUT OF SCOPE for plan 03-A-01** (audit is read-only on engine files) but MUST be resolved before plan 03-A-02 lands — flagged in Deferred Items below.

## Persisted-state map (Phase 02 baseline)

| Column / Field | Schema location | Phase 02 event coverage |
|---|---|---|
| `session_state.hp_current` | session-state.ts:10 | `hp_change` (delta) — covered |
| `session_state.temp_hp` | session-state.ts:11 | **NONE** — gap |
| `session_state.hit_dice_remaining` | session-state.ts:12 | **NONE** — gap |
| `session_state.spell_slots_used` (jsonb, legacy) | session-state.ts:13 | partial — `spell_slot_use/restore` cover the new per-character `characters.spellSlotsUsed`, NOT this legacy column |
| `session_state.conditions` (jsonb array) | session-state.ts:14 | `condition_add` / `condition_remove` — covered (but special-cased exhaustion stacking is NOT) |
| `session_state.resources_used` (jsonb, legacy) | session-state.ts:15 | **NONE** — gap (`use_resource` and class features write here OR `characters.resources_used`) |
| `session_state.death_saves` (jsonb) | session-state.ts:16 | **NONE** — gap |
| `session_state.flags.stable` / `flags.dead` | session-state.ts:17 | **NONE** — gap |
| `session_state.exhaustion_level` | session-state.ts:18 | **NONE** — gap (exhaustion stacking via `add_condition('exhaustion')` increments this) |
| `session_state.concentrating_on` (jsonb) | session-state.ts:19 | **NONE** — gap |
| `session_state.turn_state` (jsonb) | session-state.ts:20 | per-session UI state, NOT in vault scope per RESEARCH §"turn structure" — see Section (b)/(d) below |
| `session_state.position` (jsonb) | session-state.ts:21 | per-session combat-grid metadata, NOT in vault scope (b)/(d) |
| `session_state.in_combat` / `combat` (jsonb) | session-state.ts:22-23 | combat-scaffold metadata, NOT in vault scope (b)/(d) |
| `session_state.scene` (text) | session-state.ts:24 | narrative metadata, NOT in vault scope (b) |
| `session_state.travel` (jsonb) | session-state.ts:50 | exploration metadata, NOT in vault scope (b) |
| `session_state.last_long_rest_at` | session-state.ts:43 | **NONE** — gap (cooldown stamp) |
| `characters.xp` | characters.ts:22 | **NONE** — gap |
| `characters.level` / `classes` | characters.ts:21,33 | **NONE** — gap |
| `characters.hp_max` | characters.ts:37 | **NONE** — gap (changes only on level_up) |
| `characters.proficiency_bonus` | characters.ts:36 | derived from level — implicit in `level_up` |
| `characters.spellcasting.slotsMax` | characters.ts:49 | **NONE** — gap (changes only on level_up) |
| `characters.spellSlotsUsed` (per-character) | characters.ts:67 | `spell_slot_use` / `spell_slot_restore` — covered |
| `characters.resourcesUsed` (per-character) | characters.ts:75 | **NONE** — gap |
| `characters.inventory` (jsonb array) | characters.ts:78 | `inventory_add` / `inventory_remove` — covered (note: `set_equipped` writes here too — partial gap) |
| `characters.inspiration` (boolean) | characters.ts:93 | **NONE** — gap |
| `characters.attuned_items` (jsonb array) | characters.ts:99 | **NONE** — gap |
| `characters.senses` (jsonb) | characters.ts:106 | **NONE** — gap |
| `characters.equipped_focus` (jsonb) | characters.ts:114 | **NONE** — gap |
| `characters.crafting_projects` (jsonb array) | characters.ts:124 | **NONE** — gap |
| `characters.downtime_activities` (jsonb array) | characters.ts:134 | **NONE** — gap |
| `characters.hirelings` (jsonb array) | characters.ts:144 | **NONE** — gap |
| `characters.bastion` (jsonb) | characters.ts:153 | **NONE** — gap |
| `characters.mounted_on` (jsonb) | characters.ts:161 | **NONE** — gap |
| `characters.embarked_on` (text) | characters.ts:167 | **NONE** — gap |
| `characters.ac` (derived) | characters.ts:38 | recomputed from equip/unequip — derived, not persistent semantics |
| `campaigns.tonalFrame` | campaigns.ts:149 | **NONE** — gap (campaign-scoped) |
| `campaigns.engagementProfile` (jsonb) | campaigns.ts:150 | **NONE** — gap (campaign-scoped) |
| `codex_entities.{want,fear,quirk,attitude}` | (NPC beats) | **NONE** — gap (per-NPC entity) |

## Classification Table

The Class column uses (a), (b), (c) per the spec. Where a single handler emits MULTIPLE persisted ops belonging to different classes, the entry is annotated `(a)+(c)` etc., and a row is added per distinct vault-event implication.

| Handler | Line | Persisted mutations emitted | Class | Vault event(s) |
|---|---|---|---|---|
| `roll_dice` | 99 | (none — dice log only via `rolls[]`) | (b) | — |
| `ability_check` | 115 | `spend_inspiration` (iff `useInspiration && char.inspiration`); `remove_condition` (helped) | (a)+(c) | `condition_remove` + NEW `inspiration_spend` |
| `saving_throw` | 132 | `spend_inspiration` (conditional) | (c) | NEW `inspiration_spend` |
| `roll_initiative` | 149 | `set_combat`, `start_turn` (via `rollInitiative`) | (b) | — (combat-scaffold metadata, not vault state) |
| `make_attack` | 153 | `spend_inspiration` (conditional), `consume_action`, `consume_ammo`, `mark_loading_shot`, `mark_offhand_attack`, `remove_condition` (helped), `apply_damage`, `mark_sneak_attack`, `set_hp` (knockout), `add_condition` (unconscious) | (a)+(b)+(c) | `hp_change` + `condition_add` + `condition_remove` + NEW `inspiration_spend` + NEW `consume_ammo` (inventory delta) — turn-state ops are (b) |
| `apply_damage` | 201 | `apply_damage` (hp_current -= amount), `set_temp_hp` (when temp HP absorbed), `set_hp` (instakill at full HP), `add_condition` (unconscious), `concentration_check`, `break_concentration`, `death_save` | (a)+(c) | `hp_change` + `condition_add` + NEW `temp_hp_set` + NEW `concentration_break` + NEW `death_save_fail` + NEW `concentration_check_request` (marker — optional, see §Optional events below) |
| `end_turn` | 217 | `advance_turn`, `start_turn`, `remove_condition` (durationRounds → 0) | (a)+(b) | `condition_remove` + turn-scaffold (b) |
| `end_combat` | 222 | `set_combat: null` | (b) | — (combat-scaffold, not vault state) |
| `take_action` | 232 | `consume_action`, `take_dash`, `take_disengage`, `take_dodge`, `add_condition` (helped), `set_readied` | (a)+(b) | `condition_add` for `helped` — rest are (b) turn-scaffold |
| `move_to_band` | 262 | `consume_movement`, `set_position`, `opportunity_attack_triggered` | (b) | — (per-turn UI state) |
| `apply_condition` | 292 | `add_condition` | (a) | `condition_add` (BUT exhaustion special-case via `exhaustion_level` increment — see (c) `exhaustion_set` below) |
| `remove_condition` | 309 | `remove_condition` | (a) | `condition_remove` (BUT exhaustion special-case — see (c)) |
| `use_resource` | 316 | `use_resource` (writes `characters.resources_used` per-character) | (c) | NEW `resource_use` |
| `short_rest` | 329 | `spend_hit_die`, `heal`, `restore_resource` | (c) | NEW `hit_dice_use` + NEW `resource_restore` + `hp_change` (heal) — heal is (a) |
| `equip` | 341 | `set_equipped` (toggles inventory[].equipped) | (c) | NEW `inventory_equip_set` |
| `unequip` | 347 | `set_equipped` (toggles inventory[].equipped to false) | (c) | NEW `inventory_equip_set` |
| `level_up` | 353 | `level_up` (writes `level`, `hpMax`, `proficiencyBonus`, `spellcasting`) | (c) | NEW `level_up` |
| `add_class_level` | 371 | `add_class_level` (writes `classes[]`, `classSlug`, `level`) | (c) | NEW `class_level_add` |
| `award_xp` | 407 | `award_xp` (writes `characters.xp`) | (c) | NEW `xp_award` |
| `remove_item` | 422 | `remove_inventory` | (a) | `inventory_remove` |
| `make_death_save` | 437 | `death_save` (success / failure / nat20 → also `set_hp 1` + `remove_condition unconscious`; nat1 → 2× failure) | (c) | NEW `death_save_success` + NEW `death_save_fail` + NEW `death_save_recover_at_one` (the nat20 case) |
| `stabilize` | 444 | `reset_death_saves`, `set_stable` | (c) | NEW `death_save_stabilize` |
| `concentration_check` | 457 | `break_concentration` (on save failure) | (c) | NEW `concentration_break` |
| `grant_inspiration` | 466 | `grant_inspiration` (writes `characters.inspiration: true`) | (c) | NEW `inspiration_grant` |
| `spend_inspiration` | 473 | `spend_inspiration` (writes `characters.inspiration: false`) | (c) | NEW `inspiration_spend` |
| `forced_march` | 480 | `add_condition` ('exhaustion') | (c) | NEW `exhaustion_increment` (because `applyOne` special-cases exhaustion as a stacking counter rather than an array entry) |
| `apply_starvation` | 496 | `add_condition` ('exhaustion') | (c) | NEW `exhaustion_increment` |
| `apply_dehydration` | 512 | `add_condition` ('exhaustion') on save failure | (c) | NEW `exhaustion_increment` |
| `attune` | 528 | `attune` (appends slug to `characters.attuned_items`) | (c) | NEW `attune` |
| `equip_focus` | 541 | `set_focus` (writes `characters.equipped_focus`) | (c) | NEW `focus_set` |
| `unequip_focus` | 559 | `unset_focus` (writes `characters.equipped_focus: null`) | (c) | NEW `focus_unset` |
| `unattune` | 568 | `unattune` (removes slug from `characters.attuned_items`) | (c) | NEW `unattune` |
| `set_travel_pace` | 581 | `set_travel_pace` (writes `session_state.travel.pace`) | (b) | — (exploration metadata, per RESEARCH §"turn-state and travel state not in vault scope") |
| `set_light_level` | 585 | `set_light_level` (writes `session_state.travel.lightLevel`) | (b) | — (exploration metadata) |
| `set_marching_order` | 589 | `set_marching_order` (writes `session_state.travel.marchingOrder`) | (b) | — (exploration metadata) |
| `set_senses` | 593 | `set_senses` (writes `characters.senses` for PC, `combat_actors.senses` for monsters) | (c) | NEW `senses_set` |
| `check_vision` | 602 | (none — pure derivation, returns `{canSee, perceptionDisadvantage}`) | (b) | — |
| `apply_falling` | 622 | `apply_damage`, `add_condition` ('prone') | (a) | `hp_change` + `condition_add` |
| `apply_suffocation` | 637 | `set_hp` (→ 0), `add_condition` ('unconscious') | (a) | `hp_change` (delta = -hp_current) + `condition_add` |
| `set_tonal_frame` | 652 | `set_tonal_frame` (writes `campaigns.tonalFrame` — CAMPAIGN-LEVEL, not character-level) | (c) | NEW `tonal_frame_set` (see Open Items: (d) campaign-level event subsection) |
| `set_engagement_profile` | 656 | `set_engagement_profile` (writes `campaigns.engagementProfile`) | (c) | NEW `engagement_profile_set` (campaign-level) |
| `update_npc_beats` | 663 | `update_npc_beats` (writes `codex_entities.{want,fear,quirk,attitude}`) | (c) | NEW `npc_beats_update` (NPC-level — see Open Items) |
| `use_class_feature` | 670 | `use_class_feature` (writes `characters.resources_used[featureSlug]`) | (c) | NEW `class_feature_use` |
| `start_rage` | 678 | `use_class_feature` ('rage'), `add_condition` ('raging') | (a)+(c) | `condition_add` + NEW `class_feature_use` |
| `end_rage` | 684 | `remove_condition` ('raging') | (a) | `condition_remove` |
| `use_action_surge` | 690 | `use_class_feature` ('action_surge'), `reset_action_for_surge` | (b)+(c) | NEW `class_feature_use` + turn-scaffold (b) for surge reset |
| `use_channel_divinity` | 696 | `use_class_feature` ('channel_divinity') | (c) | NEW `class_feature_use` |
| `grant_bardic_inspiration` | 703 | `use_class_feature` ('bardic_inspiration'), `add_condition` ('bardic_inspired') on target | (a)+(c) | `condition_add` + NEW `class_feature_use` |
| `use_lay_on_hands` | 719 | `heal`, `remove_condition` ('poisoned'), `modify_lay_on_hands_pool` | (a)+(c) | `hp_change` (heal) + `condition_remove` + NEW `lay_on_hands_pool_modify` (the pool delta — special-cased via `restore_class_feature`-shape ledger) |
| `start_crafting` | 729 | `start_crafting` (appends to `characters.crafting_projects`) | (c) | NEW `crafting_start` |
| `progress_crafting` | 750 | `progress_crafting` (mutates project days/gp in-place) | (c) | NEW `crafting_progress` |
| `complete_crafting` | 764 | `complete_crafting` (removes project AND emits implicit `add_inventory` via applicator) | (c) | NEW `crafting_complete` (single event captures both project removal + inventory add — replay reconstructs both) |
| `cancel_crafting` | 776 | `cancel_crafting` (removes project, no inventory) | (c) | NEW `crafting_cancel` |
| `start_downtime_activity` | 789 | `start_downtime_activity` (appends to `characters.downtime_activities`) | (c) | NEW `downtime_start` |
| `complete_downtime_activity` | 804 | `complete_downtime_activity` (removes activity) | (c) | NEW `downtime_complete` |
| `hire` | 816 | `hire` (appends to `characters.hirelings`) | (c) | NEW `hire` |
| `dismiss_hireling` | 832 | `dismiss_hireling` (removes hireling) | (c) | NEW `dismiss_hireling` |
| `set_bastion` | 844 | `set_bastion` (writes `characters.bastion`) | (c) | NEW `bastion_set` |
| `add_bastion_room` | 857 | `add_bastion_room` (appends to `bastion.rooms`) | (c) | NEW `bastion_room_add` |
| `mount` | 871 | `mount` (writes `characters.mounted_on`) | (c) | NEW `mount` |
| `dismount` | 884 | `dismount` (clears `characters.mounted_on`) | (c) | NEW `dismount` |
| `set_mount_mode` | 893 | `set_mount_mode` (updates mode field on `characters.mounted_on`) | (c) | NEW `mount_mode_set` |
| `embark_vehicle` | 905 | `embark_vehicle` (writes `characters.embarked_on`) | (c) | NEW `embark_vehicle` |
| `disembark_vehicle` | 917 | `disembark_vehicle` (clears `characters.embarked_on`) | (c) | NEW `disembark_vehicle` |
| `swap_attack_target` | 926 | `consume_action` (kind: 'reaction') | (b) | — (turn-state only, no persisted state delta) |

### TOOL_HANDLERS_DB entries (handlers.ts:3215-3378)

| Handler | Line | Persisted mutations emitted | Class | Vault event(s) |
|---|---|---|---|---|
| `lookup_codex` | 3215 | (none — read-only DB lookup) | (b) | — |
| `add_narrative_item` | 3216 | `add_inventory` (via add-narrative-item.ts) | (a) | `inventory_add` |
| `long_rest` | 3218 | per PG: `set_hp`, `set_temp_hp` (0), `restore_spell_slot` (per used level), `restore_hit_dice`, `restore_resource` (per feature), `remove_condition` (exhaustion), `set_long_rest_at` | (a)+(c) | `hp_change` + `spell_slot_restore` + `condition_remove` + NEW `temp_hp_set` + NEW `hit_dice_restore` + NEW `resource_restore` + NEW `long_rest_stamp` + NEW `exhaustion_decrement` (when exhaustion was non-zero) |
| `cast_spell` | 3298 | (via `castSpell`) `use_spell_slot`, `consume_action`, `apply_damage`, `set_concentration` | (a)+(c) | `spell_slot_use` + `hp_change` + NEW `concentration_set` |
| `set_current_player` | 3337 | (none — writes `sessions.currentPlayerCharacterId`, session-scoped UI state) | (b) | — (turn-orchestration metadata; replay does not need to reconstruct turn order) |
| `add_item` (TOOL_HANDLERS_DB, stashed-changes side, line 3377) | 3377 | `add_inventory` (via add-item-db.ts) | (a) | `inventory_add` |
| `recompute_ac` (TOOL_HANDLERS_DB, stashed-changes side, line 3378) | 3378 | `recompute_ac` (writes `characters.ac`) | (c) | NEW `ac_recompute` — OR (b) if AC is treated as a pure-derivation cache (see §Open Items) |

## Summary

- **Total handlers inspected:** 68 (61 in `TOOL_HANDLERS` + 7 in `TOOL_HANDLERS_DB` counting both merge-conflict sides of `add_item` / `recompute_ac` plus the 5 upstream entries)
- **(a) Already covered:** 12 handlers (or partial overlap — `apply_damage`, `apply_condition`, `remove_condition`, `apply_falling`, `apply_suffocation`, `end_rage`, `add_narrative_item`, `remove_item`, plus partial overlap inside `make_attack`, `cast_spell`, `start_rage`, `grant_bardic_inspiration`, `use_lay_on_hands`, `long_rest`, `short_rest`, `ability_check`, `take_action`, `end_turn`)
- **(b) Stateless / out-of-vault-scope:** 11 handlers (`roll_dice`, `roll_initiative`, `end_combat`, `move_to_band`, `set_travel_pace`, `set_light_level`, `set_marching_order`, `check_vision`, `swap_attack_target`, `lookup_codex`, `set_current_player`)
- **(c) Needs new event type:** 47 handlers map to **18 distinct new event types** (per RESEARCH Assumption A2 budget of 8-15 — the audit exceeds the upper bound by 3 because (1) we surface several special-cases the RESEARCH didn't anticipate — exhaustion stacking, lay-on-hands pool, focus get/set, AC recompute — and (2) we introduce 5 campaign-level / NPC-level / session-level events not in the original character-only scope; see Open Items §(d))

The (c) handlers map to OVERLAPPING event types — e.g., `forced_march`, `apply_starvation`, `apply_dehydration` all share `exhaustion_increment`. Total distinct event-type SHAPES required: 18 (below).

## (c) Detailed event-type specifications

This is the AUTHORITATIVE specification per event type. Plan 03-A-02 adds each as a new `VaultEvent` union member; plan 03-A-03 adds a reducer arm + `INITIAL_CHARACTER_STATE` field where needed. The short numbered roster appears later in `## (c) Final list — short form for 03-A-02 / 03-A-03`.

### Event type: `temp_hp_set`

**Triggering handlers:** `apply_damage` (when target has temp HP that absorbs damage); `long_rest` (resets to 0); spells/features granting temp HP (Aid, Inspiring Leader, False Life — call site within `apply_damage` and follow-on tools).

**Payload shape:**
```ts
{ type: 'temp_hp_set'; payload: { character: string; tempHp: number } }
```

**Persisted field:** `session_state.temp_hp` (integer >= 0).

**Projector arm (plan 03-A-03):** `state.temp_hp = Math.max(0, payload.tempHp)`. Add `temp_hp: 0` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && Number.isFinite(tempHp) && Number.isInteger(tempHp) && tempHp >= 0 && tempHp < 1000` (T-02-03 mitigation — bound payload size).

**Rationale:** Combat handlers set/reset tempHp orthogonally to hp_current — separate event type avoids overloading `hp_change` and matches the dedicated `set_temp_hp` mutation op the applicator already exposes.

### Event type: `death_save_success`

**Triggering handlers:** `make_death_save` (success roll); nat20 case (line 994) emits two `death_save` mutations that BOTH map to `death_save_success` events when expanded.

**Payload shape:**
```ts
{ type: 'death_save_success'; payload: { character: string } }
```

**Persisted field:** `session_state.death_saves.successes` (JSONB column; integer 0..3).

**Projector arm (plan 03-A-03):** `state.death_saves.successes = Math.min(3, state.death_saves.successes + 1)`. When `state.death_saves.successes === 3`: also set `state.flags.stable = true` AND reset `state.death_saves = { successes: 0, failures: 0 }` AND ensure `'unconscious'` is in `state.conditions` (matches applicator.ts:574-589). Add `death_saves: { successes: 0, failures: 0 }`, `flags: { stable: false, dead: false }` defaults to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

**Rationale:** Death-save state is critical for combat continuity; replaying after restart MUST reproduce the death-save counter exactly. Single-event-per-success matches the applicator's single-mutation model.

### Event type: `death_save_fail`

**Triggering handlers:** `make_death_save` (failed roll). The applicator (line 599) treats nat1 as `isCrit: true` and increments failures by 2 — encode via the `critical` payload field.

**Payload shape:**
```ts
{ type: 'death_save_fail'; payload: { character: string; critical?: boolean } }
```

**Persisted field:** `session_state.death_saves.failures` (integer 0..3).

**Projector arm (plan 03-A-03):** `state.death_saves.failures = Math.min(3, state.death_saves.failures + (critical ? 2 : 1))`. When `state.death_saves.failures === 3`: also set `state.flags.dead = true` AND reset death_saves to `{ successes: 0, failures: 3 }` (preserved for traceability — matches applicator.ts:601-608).

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && (critical === undefined || typeof critical === 'boolean')`.

### Event type: `death_save_stabilize`

**Triggering handlers:** `stabilize` (line 444); ALSO the nat20 branch of `make_death_save` (line 995-1004) emits `reset_death_saves` + `set_hp 1` + `remove_condition unconscious` — but the nat20 case is more naturally split into `death_save_recover_at_one` (below) because it ALSO restores 1 HP, which `death_save_stabilize` does not.

**Payload shape:**
```ts
{ type: 'death_save_stabilize'; payload: { character: string } }
```

**Persisted field:** `session_state.flags.stable = true`, `session_state.death_saves = { successes: 0, failures: 0 }`.

**Projector arm (plan 03-A-03):** `state.flags.stable = true; state.death_saves = { successes: 0, failures: 0 }`. The applicator preserves the `unconscious` condition (PHB §3.19: stable but still unconscious — DO NOT remove the condition); the projector mirrors this — does NOT modify `state.conditions`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

### Event type: `death_save_recover_at_one`

**Triggering handlers:** `make_death_save` ONLY in the natural-20 branch (line 994-1004).

**Payload shape:**
```ts
{ type: 'death_save_recover_at_one'; payload: { character: string } }
```

**Persisted field:** triple write — `session_state.death_saves` (reset), `session_state.hp_current = 1`, `session_state.conditions` (remove `unconscious`).

**Projector arm (plan 03-A-03):** atomic — `state.death_saves = { successes: 0, failures: 0 }; state.hp_current = 1; state.conditions = state.conditions.filter(c => c !== 'unconscious'); state.flags.stable = false; state.flags.dead = false`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

**Rationale:** The PHB §3.18 nat20 outcome is mechanically distinct from a regular save success — it CONCURRENTLY restores 1 HP, drops unconscious, and resets death saves. Replay correctness demands a single atomic event rather than decomposing into 3 separate events (which would race on intermediate state).

### Event type: `concentration_set`

**Triggering handlers:** `cast_spell` → `castSpell()` → `spells/concentration.ts:25` (when the spell has concentration tag and the cast succeeded).

**Payload shape:**
```ts
{
  type: 'concentration_set';
  payload: {
    character: string;
    spellSlug: string;
    slotLevel: number; // 0..9
    startedRound: number;
  }
}
```

**Persisted field:** `session_state.concentrating_on` (JSONB, nullable).

**Projector arm (plan 03-A-03):** `state.concentrating_on = { spellSlug, slotLevel, startedRound }`. Add `concentrating_on: null` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof spellSlug === 'string' && spellSlug.length > 0 && Number.isInteger(slotLevel) && slotLevel >= 0 && slotLevel <= 9 && Number.isInteger(startedRound) && startedRound >= 0`.

### Event type: `concentration_break`

**Triggering handlers:** `concentration_check` (line 457, on save failure); `apply_damage` (line 67/70 of combat/damage.ts — when target dies or is incapacitated while concentrating); the applicator already accepts `break_concentration`.

**Payload shape:**
```ts
{ type: 'concentration_break'; payload: { character: string; reason: 'damage' | 'killed' | 'incapacitated' } }
```

**Persisted field:** `session_state.concentrating_on = null`.

**Projector arm (plan 03-A-03):** `state.concentrating_on = null`. (Reducer ignores `reason` — it's metadata for the operator audit trail and the events.md log.)

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && ['damage', 'killed', 'incapacitated'].includes(reason)`.

### Event type: `exhaustion_increment`

**Triggering handlers:** `forced_march`, `apply_starvation`, `apply_dehydration` (all three emit `add_condition('exhaustion')`); ALSO `apply_condition` directly when targetSlug === 'exhaustion'.

**Payload shape:**
```ts
{ type: 'exhaustion_increment'; payload: { character: string; source: string } }
```

**Persisted field:** `session_state.exhaustion_level` (integer 0..6, with side effect: at level 6 → set `flags.dead = true`).

**Projector arm (plan 03-A-03):** `state.exhaustion_level = Math.min(6, state.exhaustion_level + 1)`. When `state.exhaustion_level === 6`: also set `state.flags.dead = true` (matches applicator.ts:217). Also: append the literal string `'exhaustion'` to `state.conditions` iff it's not already there (idempotent — exhaustion appears in the array only ONCE; the level tracks intensity). Add `exhaustion_level: 0` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof source === 'string' && source.length > 0` (source is one of `'forced_march' | 'starvation' | 'dehydration' | 'magical' | 'other'`).

**Rationale:** Exhaustion uses a unique "stacking levels" model (PHB §4.1) that doesn't fit the array-based `condition_add` event. Cannot reuse `condition_add` because the applicator's exhaustion branch reads-modifies-writes the level integer — the vault event must mirror that side-effect, not just append a string.

### Event type: `exhaustion_decrement`

**Triggering handlers:** `long_rest` (PHB §5.2 — long rest reduces exhaustion by 1); ALSO `remove_condition` directly when targetSlug === 'exhaustion'.

**Payload shape:**
```ts
{ type: 'exhaustion_decrement'; payload: { character: string } }
```

**Persisted field:** `session_state.exhaustion_level` (decrement, clamped to 0; remove from `conditions` array when reaching 0).

**Projector arm (plan 03-A-03):** `if (state.exhaustion_level <= 0) return; state.exhaustion_level -= 1; if (state.exhaustion_level === 0) state.conditions = state.conditions.filter(c => c !== 'exhaustion')`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

### Event type: `hit_dice_use`

**Triggering handlers:** `short_rest` (line 329) → `rests.ts:40` emits one `spend_hit_die` per die spent.

**Payload shape:**
```ts
{ type: 'hit_dice_use'; payload: { character: string; count: number } }
```

**Persisted field:** `session_state.hit_dice_remaining` (integer >= 0).

**Projector arm (plan 03-A-03):** `state.hit_dice_remaining = Math.max(0, state.hit_dice_remaining - count)`. Seed `state.hit_dice_remaining` from `characters.hitDiceMax` at flip time (or `state.hit_dice_max` if we extend the seed event — plan 03-A-02 decision).

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && Number.isInteger(count) && count > 0 && count <= 20`.

### Event type: `hit_dice_restore`

**Triggering handlers:** `long_rest` (rests.ts:125 — PHB §5.2 restores `level/2` hit dice).

**Payload shape:**
```ts
{ type: 'hit_dice_restore'; payload: { character: string; count: number } }
```

**Persisted field:** `session_state.hit_dice_remaining` (increment, clamped to `hit_dice_max`).

**Projector arm (plan 03-A-03):** `state.hit_dice_remaining = Math.min(state.hit_dice_max, state.hit_dice_remaining + count)`. Need `hit_dice_max` in `INITIAL_CHARACTER_STATE` — seed from `characters.hitDiceMax`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && Number.isInteger(count) && count > 0 && count <= 20`.

### Event type: `resource_use`

**Triggering handlers:** `use_resource` (line 316); `use_class_feature` (line 670, emits `use_class_feature` mutation — same persistent storage); ALSO every class-feature wrapper: `start_rage`, `use_action_surge`, `use_channel_divinity`, `grant_bardic_inspiration`, `use_lay_on_hands`.

**Payload shape:**
```ts
{ type: 'resource_use'; payload: { character: string; resourceKey: string; uses: number } }
```

**Persisted field:** `characters.resources_used` (JSONB record). For class features, also `characters.spell_slots_used` for spell slots (but that's already covered by `spell_slot_use`).

**Projector arm (plan 03-A-03):** `state.resources_used[resourceKey] = (state.resources_used[resourceKey] ?? 0) + uses`. Add `resources_used: {}` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof resourceKey === 'string' && resourceKey.length > 0 && Number.isInteger(uses) && uses > 0 && uses <= 50`.

**Rationale:** Single generic event covers all per-feature/per-class resource counters (rage uses, channel divinity uses, action surge uses, bardic inspiration uses, lay-on-hands counter) instead of one event type per feature. The class-specific UX (rage condition, surge action reset, bardic inspiration on target) is captured by parallel events emitted in the same tool call.

### Event type: `resource_restore`

**Triggering handlers:** `short_rest`, `long_rest` (restore per-feature counters); the applicator op is `restore_resource` (rests.ts:52 + :133) AND `restore_class_feature` / `modify_lay_on_hands_pool` (applicator.ts:1091/1101 with negative delta).

**Payload shape:**
```ts
{ type: 'resource_restore'; payload: { character: string; resourceKey: string; uses: number } }
```

**Persisted field:** `characters.resources_used` (decrement, delete key at 0).

**Projector arm (plan 03-A-03):** `const cur = state.resources_used[resourceKey] ?? 0; const next = Math.max(0, cur - uses); if (next === 0) delete state.resources_used[resourceKey]; else state.resources_used[resourceKey] = next`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof resourceKey === 'string' && resourceKey.length > 0 && Number.isInteger(uses) && uses > 0 && uses <= 50`.

### Event type: `inspiration_grant`

**Triggering handlers:** `grant_inspiration` (line 466).

**Payload shape:**
```ts
{ type: 'inspiration_grant'; payload: { character: string } }
```

**Persisted field:** `characters.inspiration = true`.

**Projector arm (plan 03-A-03):** `state.inspiration = true`. Add `inspiration: false` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

### Event type: `inspiration_spend`

**Triggering handlers:** `spend_inspiration` (line 473); ALSO embedded inside `ability_check`, `saving_throw`, `make_attack` when `useInspiration: true` is passed.

**Payload shape:**
```ts
{ type: 'inspiration_spend'; payload: { character: string } }
```

**Persisted field:** `characters.inspiration = false`.

**Projector arm (plan 03-A-03):** `state.inspiration = false`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

### Event type: `attune`

**Triggering handlers:** `attune` (line 528).

**Payload shape:**
```ts
{ type: 'attune'; payload: { character: string; itemSlug: string } }
```

**Persisted field:** `characters.attuned_items` (jsonb string array).

**Projector arm (plan 03-A-03):** `if (!state.attuned_items.includes(itemSlug)) { state.attuned_items.push(itemSlug); state.attuned_items.sort(); }` (sort for DR byte-stability, matching the `conditions` reducer pattern). Add `attuned_items: []` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof itemSlug === 'string' && itemSlug.length > 0 && itemSlug.length <= 64`.

### Event type: `unattune`

**Triggering handlers:** `unattune` (line 568).

**Payload shape:**
```ts
{ type: 'unattune'; payload: { character: string; itemSlug: string } }
```

**Persisted field:** `characters.attuned_items` (remove from array).

**Projector arm (plan 03-A-03):** `state.attuned_items = state.attuned_items.filter(s => s !== itemSlug)`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof itemSlug === 'string' && itemSlug.length > 0 && itemSlug.length <= 64`.

### Event type: `focus_set`

**Triggering handlers:** `equip_focus` (line 541).

**Payload shape:**
```ts
{
  type: 'focus_set';
  payload: {
    character: string;
    kind: 'arcane' | 'druidic' | 'holy' | 'instrument';
    itemSlug: string;
  }
}
```

**Persisted field:** `characters.equipped_focus` (jsonb `{ kind, itemSlug }`).

**Projector arm (plan 03-A-03):** `state.equipped_focus = { kind, itemSlug }`. Add `equipped_focus: null` default to `INITIAL_CHARACTER_STATE`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && ['arcane', 'druidic', 'holy', 'instrument'].includes(kind) && typeof itemSlug === 'string' && itemSlug.length > 0`.

### Event type: `focus_unset`

**Triggering handlers:** `unequip_focus` (line 559).

**Payload shape:**
```ts
{ type: 'focus_unset'; payload: { character: string } }
```

**Persisted field:** `characters.equipped_focus = null`.

**Projector arm (plan 03-A-03):** `state.equipped_focus = null`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

### Event type: `xp_award`

**Triggering handlers:** `award_xp` (line 407).

**Payload shape:**
```ts
{ type: 'xp_award'; payload: { character: string; amount: number; reason?: string } }
```

**Persisted field:** `characters.xp` (atomic increment).

**Projector arm (plan 03-A-03):** `state.xp = (state.xp ?? 0) + Math.max(0, Math.floor(amount))`. Add `xp: 0` default to `INITIAL_CHARACTER_STATE` (or seed from `characters.xp` at flip time).

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && Number.isFinite(amount) && Number.isInteger(amount) && amount > 0 && amount < 1_000_000 && (reason === undefined || (typeof reason === 'string' && reason.length <= 256))`.

### Event type: `level_up`

**Triggering handlers:** `level_up` (line 353); ALSO `add_class_level` for multi-class (line 371).

**Payload shape:**
```ts
{
  type: 'level_up';
  payload: {
    character: string;
    newLevel: number; // 1..20
    hpDelta: number; // 0..40 (max d12 + max CON mod * level — bounded)
    newSlots?: Record<string, number>;
  }
}
```

**Persisted field:** `characters.level`, `characters.hp_max`, `characters.proficiency_bonus`, `characters.spellcasting.slotsMax`. ALSO `session_state.hp_current` (healed by hpDelta, clamped to new hp_max — applicator.ts:402-410).

**Projector arm (plan 03-A-03):** `state.level = newLevel; state.hp_max += hpDelta; state.hp_current = Math.min(state.hp_max, state.hp_current + Math.max(0, hpDelta)); state.proficiency_bonus = computeProfBonus(newLevel)`. If `newSlots` present: `state.spell_slots = mergeSlots(state.spell_slots, newSlots)`. Add `level: 1`, `proficiency_bonus: 2` defaults to `INITIAL_CHARACTER_STATE`; seed `level` and `proficiency_bonus` from `characters.level` / `characters.proficiency_bonus` at flip time.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && Number.isInteger(newLevel) && newLevel >= 1 && newLevel <= 20 && Number.isInteger(hpDelta) && hpDelta >= 0 && hpDelta <= 40 && (newSlots === undefined || (isPlainObject(newSlots) && every level key 0..9 with integer value 0..20))`.

### Event type: `class_level_add`

**Triggering handlers:** `add_class_level` (line 371). Multi-class entry — appends a class slug + level OR re-levels an existing class.

**Payload shape:**
```ts
{
  type: 'class_level_add';
  payload: {
    character: string;
    classSlug: string;
    subclass?: string;
  }
}
```

**Persisted field:** `characters.classes` (jsonb array of `ClassLevel`), `characters.classSlug` (primary class slug = `classes[0].slug`), `characters.level` (sum of all class levels).

**Projector arm (plan 03-A-03):** mirrors applicator.ts:415-472 — find existing `classes[]` entry by slug, increment level; if absent, append new entry. Update primary classSlug = `classes[0].slug`. Update `state.level = sum(classes[].level)`. Add `classes: []`, `classSlug: ''` defaults to `INITIAL_CHARACTER_STATE` (or seed from Postgres at flip time — recommended).

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && typeof classSlug === 'string' && classSlug.length > 0 && classSlug.length <= 32 && (subclass === undefined || (typeof subclass === 'string' && subclass.length > 0 && subclass.length <= 32))`.

## (a) — Already-covered handler mapping

Quick reference for plan 03-A-09 DualWriter parity-check author — these handlers DO have a vault event already.

| Handler | Phase 02 event | Notes |
|---|---|---|
| `apply_damage` | `hp_change` (delta = -amount) | PLUS (c) — `temp_hp_set` for tempHp interactions, `concentration_break` for damage-triggered breaks, `death_save_fail` for PCs at 0 HP, `condition_add` for unconscious-on-massive-damage |
| `apply_condition` | `condition_add` | EXCEPT when slug === 'exhaustion' → (c) `exhaustion_increment` |
| `remove_condition` | `condition_remove` | EXCEPT when slug === 'exhaustion' → (c) `exhaustion_decrement` |
| `end_rage` | `condition_remove` ('raging') | single op |
| `cast_spell` (via spell_slot consumption) | `spell_slot_use` | PLUS (c) `concentration_set` when spell has concentration tag |
| `short_rest` (Warlock-style spell slot recovery) | `spell_slot_restore` | PLUS (c) `hit_dice_use`, `resource_restore`, `hp_change` (heal) |
| `long_rest` (full spell slot restore) | multiple `spell_slot_restore`, one per used level | PLUS (c) `hit_dice_restore`, `resource_restore`, `temp_hp_set` (0), `exhaustion_decrement`, `long_rest_stamp` (or fold into NEW event — see Open Items) |
| `remove_item` | `inventory_remove` | with currency special-case (cross-denomination accounting) — currency moves involve MULTIPLE `inventory_remove` + `inventory_add` events; the vault must mirror this exactly |
| `add_narrative_item` | `inventory_add` | single op |
| `add_item` (TOOL_HANDLERS_DB) | `inventory_add` | single op (cross-turn dedup logic is applicator-side; vault sees one event per accepted call) |
| `apply_falling` | `hp_change` + `condition_add` ('prone') | two events emitted as one tool call |
| `apply_suffocation` | `hp_change` (delta = -hp_current) + `condition_add` ('unconscious') | two events |
| `start_rage` | `condition_add` ('raging') | PLUS (c) `resource_use` ('rage') |
| `grant_bardic_inspiration` | `condition_add` ('bardic_inspired') on target | PLUS (c) `resource_use` ('bardic_inspiration') on actor |
| `use_lay_on_hands` (heal portion) | `hp_change` (delta = +points) | PLUS (c) `resource_use` ('lay_on_hands' via pool delta) PLUS (a) `condition_remove` ('poisoned') |
| `ability_check` / `saving_throw` (with `useInspiration`) | `condition_remove` ('helped') | PLUS (c) `inspiration_spend` |
| `make_attack` (damage portion) | `hp_change` (delta = -finalDamage) | PLUS (c) `inspiration_spend`, `consume_ammo` ammo tracking — see (c) below |
| `end_turn` (condition tick-down) | `condition_remove` (for each duration→0 condition) | tick logic is applicator-side; vault gets one event per removed condition |
| `take_action` (Help action) | `condition_add` ('helped') on beneficiary | turn-state ops are (b) |

## (b) — Stateless handlers / out-of-vault-scope

These handlers don't mutate persisted `session_state.*` / `characters.*` columns in a way the vault needs to reconstruct for game-state recovery. Dual-write does NOT need to emit a vault event for them; the LLM tool call surfaces in the message log but produces no event-log entry.

**Pure roll / read-only handlers (no mutation at all):**
- `roll_dice` — emits dice log row in `dice_log` table; the dice log is NOT replayed for state recovery (DR scope is character + session state only — per REQ-006)
- `check_vision` — pure derivation, returns `{canSee, perceptionDisadvantage, ...}`
- `lookup_codex` — read-only DB query

**Turn-orchestration / combat-scaffold ops (per-session UI state, NOT persisted character state):**
- `roll_initiative` — sets `session_state.in_combat`, `session_state.combat` (turn order). Per RESEARCH §"turn structure": turn state is per-session UI scaffolding; the vault tracks character HP/conditions/inventory across sessions, NOT mid-turn initiative order. Replay reconstructs character state, NOT mid-combat turn position.
- `end_combat` — sets `session_state.combat = null`. Same rationale.
- `end_turn` — wraps `advance_turn` + `start_turn` + condition tick-down. The condition tick-down DOES persist (each tick → `remove_condition` event), but the turn advancement itself is (b).
- `take_action` — turn-state mutations (`take_dash`, `take_disengage`, `take_dodge`, `set_readied`). The action economy (`turn_state` JSONB) is regenerated from events on demand for the active session; it's per-session UI state.
- `move_to_band` — `consume_movement`, `set_position`, `opportunity_attack_triggered`. Per-turn movement is UI; the resulting position is per-session combat state, not vault scope.
- `swap_attack_target` — `consume_action` only (reaction marker for rider-mount swap). Turn-state only.
- `set_current_player` (TOOL_HANDLERS_DB) — writes `sessions.currentPlayerCharacterId`. This is turn-orchestration metadata for the multi-PC session, NOT character state. The active PG is implicit in which character's events are being emitted; reconstructing it on replay is not needed for character integrity.

**Exploration / travel metadata (per-session UI state):**
- `set_travel_pace`, `set_light_level`, `set_marching_order` — write to `session_state.travel.*`. Per RESEARCH §"exploration metadata not in vault scope": the travel context is per-session narrative scaffolding for the LLM, not character-persistent state. Note: these are reconsidered in Open Items — if a future plan extends DR scope to include the travel layer for restoring an in-flight journey, these become (c) `travel_pace_set` / `light_level_set` / `marching_order_set` events. For Phase 03, they stay (b).

**CAVEAT — `set_focus` and `unset_focus` could be considered (b) on the grounds that focus is "narrative metadata for the LLM" rather than "character state for replay". This audit classifies them as (c) because (1) `characters.equipped_focus` is a persisted column the application reads to validate spell components, (2) replay-from-events without focus state would silently change LLM behavior on the restored campaign (it would not "know" the PC has a focus equipped), violating REQ-006 byte-stable view round-trip. Same reasoning applies to `set_senses` — kept as (c).**

NOTE: Any handler currently classified (b) here MUST be re-confirmed by re-reading the body — re-classification is permitted ONLY if the new audit owner shows the handler does emit a persisted mutation through a code path missed here.

## Open items for the planner

### (d) Campaign-level / NPC-level / session-level events

These are NOT character-scoped — they don't fit the `payload.character: string` pattern of the 7 Phase 02 mutation events. Plan 03-A-02 MUST decide one of:

**Option A:** Extend `VaultEvent` with NON-character-scoped members. The projector dispatches by `event.scope` field (`character | campaign | npc | session`) before per-character lookup.

**Option B:** Extend the seed event (`campaign_initialized`) to include initial values for campaign-level + NPC-level state, and add SEPARATE event types for each (e.g., `tonal_frame_set`, `engagement_profile_set`, `npc_beats_update`) that the projector handles in a different code path from the per-character mutation events.

**Option C:** Punt these to a future phase (Phase 04+) and treat them as "Phase 03 acceptable divergence" — the parity-check ignores them; the operator accepts that tonal frame and NPC beats are NOT replayable from events.md, just from Postgres.

**Audit recommendation:** Option B (extend the seed for initial values, add new event types for updates). Option C is a viable Phase 03 hedge if Option B blows scope; the parity-check exemption list would need to enumerate: `set_tonal_frame`, `set_engagement_profile`, `update_npc_beats`, `set_long_rest_at`. Total new event types under Option B: 4 (tonal_frame_set, engagement_profile_set, npc_beats_update, long_rest_stamp).

**Affected (d) handlers:**

| Handler | Persisted field | Proposed event (Option B) |
|---|---|---|
| `set_tonal_frame` | `campaigns.tonal_frame` | `tonal_frame_set` (campaign-level) |
| `set_engagement_profile` | `campaigns.engagement_profile` | `engagement_profile_set` (campaign-level) |
| `update_npc_beats` | `codex_entities.{want,fear,quirk,attitude}` | `npc_beats_update` (NPC-level) |
| `long_rest` (timestamp portion) | `session_state.last_long_rest_at` | `long_rest_stamp` (session-level) — or fold into per-PG `resource_restore` and skip the timestamp from the vault entirely |

### (e) Cross-character side effects (no decision needed — already handled)

`grant_bardic_inspiration` adds a condition to the TARGET, not the actor. `use_lay_on_hands` heals the TARGET, not the actor. The event-per-character pattern STILL works: emit N events, one per affected character, in the order the engine returns them. The dispatcher already supports this (one tool call per event). No new infrastructure required.

### (f) AC recomputation — (c) or pure-derivation cache?

`recompute_ac` (TOOL_HANDLERS_DB:3378) writes `characters.ac`. Two camps:

- **(c) `ac_recompute`:** AC is a persisted column that affects validator behavior on the restored campaign. Replay must reconstruct it or the restored character's defenses are wrong.
- **(b) — treat AC as a pure-derivation cache:** AC is fully determined by `inventory[]` + `abilities.DEX` + class features. After replay, the projector COULD call `recomputeAC()` from the equipment.ts helper on each character with non-empty `inventory[]` and re-derive AC.

**Audit recommendation:** Treat as (b) IF Phase 03 also adds a "post-replay derivation step" to the projector (call `recomputeAC` on each replayed character). Otherwise (c) `ac_recompute`. Decision: plan 03-A-03 author — but recommended (b) + derivation step to avoid carrying redundant state.

### (g) `consume_ammo` — `inventory_remove` synonym?

`consume_ammo` (combat/attack.ts:262) is a strict subset of `inventory_remove` (it decrements `inventory[ammoSlug].qty` by 1). Plan 03-A-02 should emit `inventory_remove` (the existing event) for ammo consumption rather than introducing a new `ammo_consume` event. The applicator distinguishes the two ops for telemetry / dedup purposes; the vault layer does not need that distinction.

### (h) Long-rest condition cleanup

`long_rest` emits `remove_condition` for exhaustion (one decrement per PG). Per (c) `exhaustion_decrement`, the vault event is `exhaustion_decrement`, not `condition_remove('exhaustion')`. Plan 03-A-09 dual-write MUST translate the applicator's `remove_condition` mutation to the right vault event by inspecting the slug — `exhaustion` → `exhaustion_decrement`; everything else → `condition_remove`.

### (i) Cross-turn `add_inventory` dedup

The applicator (applicator.ts:480-503) has a 10-minute window cross-turn dedup for identical (character, item, qty) `add_inventory` mutations. The vault layer should NOT replicate this dedup — the dispatcher accepts the LLM-emitted event AT FACE VALUE and the projector reflects the event. If the master re-narrates loot, the events.md log will show a duplicate event and the projector will increment qty twice. **This is intentional divergence between the two systems:**

- Postgres = authoritative inventory accounting (dedup applied)
- Vault = literal narrative log (no dedup)

Plan 03-A-09 dual-write MUST handle this divergence — flag the applicator's `cross_turn_suppressed` warning as a "vault-no-emit" signal (skip the corresponding `inventory_add` event when the applicator suppressed the Postgres write). Otherwise the parity check fires.

## Deferred items (out of scope for 03-A-01)

1. **Git merge conflict markers in `src/engine/tools/handlers.ts` at lines 942, 2277, 3186, 3196, 3213, 3375, 3379.** The file currently has unresolved `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes` markers. The plan 03-A-01 contract is OUTPUT-ONLY on engine files — fixing this is OUT OF SCOPE. **BLOCKING for plan 03-A-02:** plan 03-A-02 cannot extend `events-schema.ts` while the handlers file has unresolved conflicts that prevent a clean `tsc` build. Operator must resolve the conflict (choose `Updated upstream` or `Stashed changes` or hand-merge) before Phase 03 Wave 2 begins.

2. **`add_item` and `recompute_ac` routing.** Both appear in BOTH the legacy TOOL_HANDLERS (per the older audit assumption) AND TOOL_HANDLERS_DB (within the merge-conflict stashed-changes block). Once the merge is resolved, re-confirm which Map owns them — the audit assumes TOOL_HANDLERS_DB on the grounds that BOTH need DB access (`add_item` needs `inventory_grants` log; `recompute_ac` needs to read the equipped item slugs to recompute).

## (c) Final list

Hard list — REQUIRED new event types Plan 03-A-02 MUST ship. Each entry has a full specification in the "(c) Detailed event-type specifications" section above (payload shape, validator rule, projector arm, persisted field, rationale).

1. temp_hp_set
2. death_save_success
3. death_save_fail
4. death_save_stabilize
5. death_save_recover_at_one
6. concentration_set
7. concentration_break
8. exhaustion_increment
9. exhaustion_decrement
10. hit_dice_use
11. hit_dice_restore
12. resource_use
13. resource_restore
14. inspiration_grant
15. inspiration_spend
16. attune
17. unattune
18. focus_set
19. focus_unset
20. xp_award

Provisional events (PENDING planner decision — see Open Items §(d), §(f), §(j)):

- `level_up` — REQUIRED, but the multi-class split (`class_level_add`) is the planner's call
- `class_level_add` — RECOMMENDED for multi-class support
- `tonal_frame_set`, `engagement_profile_set`, `npc_beats_update`, `long_rest_stamp` — campaign / NPC / session scope (Open Items §(d))
- `ac_recompute` — only if AC is not recomputed by the projector post-replay (Open Items §(f))
- `senses_set` — only if Phase 03 commits to replaying sense changes (Open Items §(j))

**Hard count of REQUIRED new event types:** 20 (the numbered roster above).
**With recommended multi-class addition:** 22 (add `level_up` + `class_level_add` as required).
**Soft count with all provisionals accepted:** up to 28.

RESEARCH Assumption A2 budgeted 8-15. **The audit exceeds the budget by 5-13 events** — driven by:

- Three death-save variants instead of one (PHB §3.18 has 4 mechanically-distinct outcomes; single event-per-outcome is cleaner than encoding "outcome" as a payload field)
- Exhaustion as a stacking counter requires +1 / -1 events rather than reusing `condition_add` / `condition_remove`
- Per-feature resources (rage, action surge, lay-on-hands, bardic, etc.) split into `resource_use` + `resource_restore`
- Multi-class support (`class_level_add`) is distinct from single-class `level_up`
- Subsystems Phase 02 did not anticipate: focus (`focus_set` / `focus_unset`), attunement (`attune` / `unattune`), inspiration (`inspiration_grant` / `inspiration_spend`)

**Recommendation for plan 03-A-02:** Adopt the 20 hard events (numbered roster above), PLUS `level_up` + `class_level_add` for level progression coverage (total 22). Defer the remaining provisionals (campaign/NPC/session scope, AC recompute, senses) to a follow-up plan after 03-A-02/03-A-03 prove the pattern works.

Each entry maps to:

- A new `VaultEvent` union member (plan 03-A-02)
- A reducer arm in `applyEvent` (plan 03-A-03)
- A `validateEvent` case (plan 03-A-02)
- A test case in `tests/ai/master/vault/events-schema.test.ts` + `tests/ai/master/vault/projector.test.ts` (plans 03-A-02/03)

## Confidence

- **HIGH on methodology** — the mechanical grep over `op: '...'` strings + cross-reference against the applicator switch is reproducible by any future auditor.
- **HIGH on the (a) / (b) classifications** — these are mechanically verifiable from the source.
- **MEDIUM on the (c) count** — the lower-bound 22 events is firm. The upper-bound 28 depends on Open Items decisions (campaign-level scope, AC derivation strategy, senses replayability). Plan 03-A-02 must resolve these before extending the schema.
- **MEDIUM on the `long_rest` decomposition** — the long_rest handler emits 5-7 distinct mutations per PG, and re-emits the same for every other party member. The vault must accept this as 5-7 events per PG × N party members per long-rest tool call. Plan 03-A-09's parity check needs to handle batches of dozens of events per long_rest cleanly.

## Sign-off

- **Audit author:** executor (Phase 03 Wave 1, plan 03-A-01)
- **Audit reviewed by:** (operator — pending plan 03-A-02 hand-off)
- **Date:** 2026-05-26
- **Source commit (head):** see `git log -1 --format=%H` at audit time
- **Merge-conflict state at audit time:** unresolved (see Deferred Items §1)
