import type { AnthropicTool } from '../types';

/**
 * Meta-tool definitions for local LLM providers.
 *
 * The full game engine exposes 72 individual tools (see ALWAYS_ON in
 * ./index.ts). Smaller local models (qwen3:14b, gpt-oss:20b) can't reason
 * over that catalogue fast enough to be playable. Instead we expose 8
 * "meta-tools", each grouping ~5-15 related underlying tools behind a
 * `subaction` discriminator. The runtime dispatcher (./meta-dispatcher.ts)
 * rewrites a meta call back to the underlying tool name before the game
 * applicator runs, so the engine handlers stay untouched.
 *
 * Coverage: every name in ALWAYS_ON appears in exactly one
 * META_SUBACTION_MAP entry below. The coverage test guards against drift.
 */

// ── sub-action enumerations ────────────────────────────────────────────────
// Listed flat so they can be re-used by the dispatcher (validation) and the
// coverage test (no duplicates / no missing).

export const COMBAT_SUBACTIONS = [
  'initiative',
  'attack',
  'damage',
  'end_turn',
  'end_combat',
  'swap_target',
  'condition_apply',
  'condition_remove',
  'falling',
  'death_save',
  'stabilize',
  'concentration_check',
  'move',
] as const;
export type CombatSubaction = (typeof COMBAT_SUBACTIONS)[number];

export const SPELL_SUBACTIONS = [
  'cast_spell',
  'use_resource',
  'equip_focus',
  'unequip_focus',
  'attune',
  'unattune',
] as const;
export type SpellSubaction = (typeof SPELL_SUBACTIONS)[number];

export const INVENTORY_SUBACTIONS = [
  'add_item',
  'remove_item',
  'add_narrative_item',
  'equip',
  'unequip',
  'recompute_ac',
] as const;
export type InventorySubaction = (typeof INVENTORY_SUBACTIONS)[number];

export const CHARACTER_SUBACTIONS = [
  'level_up',
  'add_class_level',
  'award_xp',
  'grant_inspiration',
  'spend_inspiration',
  'use_class_feature',
  'start_rage',
  'end_rage',
  'use_action_surge',
  'use_channel_divinity',
  'grant_bardic_inspiration',
  'use_lay_on_hands',
] as const;
export type CharacterSubaction = (typeof CHARACTER_SUBACTIONS)[number];

export const REST_SUBACTIONS = ['short_rest', 'long_rest'] as const;
export type RestSubaction = (typeof REST_SUBACTIONS)[number];

export const NARRATIVE_SUBACTIONS = [
  'lookup_codex',
  'set_current_player',
  'take_action',
  'ability_check',
  'saving_throw',
  'roll_dice',
  'roll_d20',
  'update_npc_beats',
] as const;
export type NarrativeSubaction = (typeof NARRATIVE_SUBACTIONS)[number];

export const ENVIRONMENT_SUBACTIONS = [
  'set_travel_pace',
  'set_light_level',
  'set_marching_order',
  'set_senses',
  'check_vision',
  'forced_march',
  'apply_starvation',
  'apply_dehydration',
  'apply_suffocation',
] as const;
export type EnvironmentSubaction = (typeof ENVIRONMENT_SUBACTIONS)[number];

export const META_SUBACTIONS = [
  'set_tonal_frame',
  'set_engagement_profile',
  'start_crafting',
  'progress_crafting',
  'complete_crafting',
  'cancel_crafting',
  'start_downtime_activity',
  'complete_downtime_activity',
  'hire',
  'dismiss_hireling',
  'set_bastion',
  'add_bastion_room',
  'mount',
  'dismount',
  'set_mount_mode',
  'embark_vehicle',
  'disembark_vehicle',
] as const;
export type MetaSubaction = (typeof META_SUBACTIONS)[number];

// ── sub-action → underlying tool name map ──────────────────────────────────
// For Combat, Spell, Character, Rest, Narrative, Environment, and Meta the
// sub-action IS the underlying tool name, except for two combat aliases that
// rename for clarity:
//   condition_apply  → apply_condition
//   condition_remove → remove_condition
// All other sub-actions map 1:1 to the existing ALWAYS_ON tool name.

const SUBACTION_TO_TOOL: Record<string, string> = {
  // combat aliases
  initiative: 'roll_initiative',
  attack: 'make_attack',
  damage: 'apply_damage',
  swap_target: 'swap_attack_target',
  condition_apply: 'apply_condition',
  condition_remove: 'remove_condition',
  falling: 'apply_falling',
  death_save: 'make_death_save',
  move: 'move_to_band',
};

/** Returns the underlying ALWAYS_ON tool name for a meta sub-action, or
 *  null if not recognised. Defaults to identity (sub-action IS the tool
 *  name) when no explicit mapping exists. */
export function resolveSubactionToToolName(meta: string, sub: string): string | null {
  if (!META_SUBACTIONS_BY_META[meta as MetaName]?.includes(sub)) return null;
  return SUBACTION_TO_TOOL[sub] ?? sub;
}

/** Reverse map: every meta name → list of sub-action strings.
 *  Used by the dispatcher to validate the sub-action belongs to the meta,
 *  and by the coverage test to enumerate all routings. */
export const META_SUBACTIONS_BY_META = {
  combat_action: COMBAT_SUBACTIONS as readonly string[],
  spell_action: SPELL_SUBACTIONS as readonly string[],
  inventory_action: INVENTORY_SUBACTIONS as readonly string[],
  character_action: CHARACTER_SUBACTIONS as readonly string[],
  rest_action: REST_SUBACTIONS as readonly string[],
  narrative_action: NARRATIVE_SUBACTIONS as readonly string[],
  environment_action: ENVIRONMENT_SUBACTIONS as readonly string[],
  meta_action: META_SUBACTIONS as readonly string[],
} as const satisfies Record<string, readonly string[]>;

export type MetaName = keyof typeof META_SUBACTIONS_BY_META;

export const META_NAMES: readonly MetaName[] = Object.keys(META_SUBACTIONS_BY_META) as MetaName[];

export function isMetaName(name: string): name is MetaName {
  return name in META_SUBACTIONS_BY_META;
}

// ── tool definitions exposed to the LLM ────────────────────────────────────

function metaTool(
  name: MetaName,
  description: string,
  subactions: readonly string[],
  extraProperties: Record<string, unknown> = {},
): AnthropicTool {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      required: ['subaction'],
      properties: {
        subaction: {
          type: 'string',
          enum: [...subactions],
        },
        // Family-level common parameters. Declared here (not just in
        // `description`) so Ollama's chat template — which reads the JSON
        // Schema, not the prose description — knows the meta-tool has a
        // rich shape and activates structured tool-calling. Without this,
        // qwen3-instruct (and other tool-capable bases) fall back to
        // emitting the call as text inside `content`, which the adapter
        // doesn't see → tool-loop retries → bug.
        ...extraProperties,
      },
      // The dispatcher validates the rest of `input` against the underlying
      // tool's schema; we accept any additional keys at this layer so the
      // model isn't constrained to a single rigid shape per meta. Subactions
      // that need fields not listed in `extraProperties` still work — the
      // model passes them through and the dispatcher routes them.
      additionalProperties: true,
    } as never,
  };
}

export const META_TOOL_DEFINITIONS: AnthropicTool[] = [
  metaTool(
    'combat_action',
    'Combat actions. Pick a sub-action and provide the inputs that sub-action requires:\n' +
      '- initiative: roll initiative for an actor. inputs: { actor }\n' +
      '- attack: make an attack roll. inputs: { attacker, target, weapon?, advantage?, disadvantage? }\n' +
      '- damage: apply HP damage. inputs: { target, amount, type? }\n' +
      '- end_turn: end the current actor\'s turn in initiative\n' +
      '- end_combat: leave combat mode\n' +
      '- swap_target: change attack target mid-resolution. inputs: { newTarget }\n' +
      '- condition_apply: apply a condition. inputs: { actor, condition, source? }\n' +
      '- condition_remove: remove a condition. inputs: { actor, condition }\n' +
      '- falling: apply falling damage. inputs: { actor, feet }\n' +
      '- death_save: roll a death save. inputs: { actor }\n' +
      '- stabilize: stabilize a dying actor. inputs: { actor }\n' +
      '- concentration_check: roll concentration. inputs: { actor, dc }\n' +
      '- move: tactical movement (close, near, far bands). inputs: { actor, band }',
    COMBAT_SUBACTIONS,
    {
      actor: { type: 'string', description: 'Actor ID (e.g. pc-001)' },
      attacker: { type: 'string', description: 'Attacker ID (attack subaction)' },
      target: { type: 'string', description: 'Target ID' },
      weapon: { type: 'string', description: 'Weapon slug' },
      advantage: { type: 'boolean' },
      disadvantage: { type: 'boolean' },
      amount: { type: 'integer', description: 'HP amount for damage subaction' },
      type: { type: 'string', description: 'Damage type (slashing, fire, ...)' },
      newTarget: { type: 'string', description: 'New target ID (swap_target)' },
      condition: { type: 'string', description: 'Condition slug' },
      source: { type: 'string', description: 'Source of condition/effect' },
      feet: { type: 'integer', description: 'Falling distance in feet' },
      dc: { type: 'integer', description: 'Difficulty Class' },
      band: { type: 'string', description: 'Movement band (close, near, far)' },
    },
  ),
  metaTool(
    'spell_action',
    'Spellcasting and magical-item actions:\n' +
      '- cast_spell: resolve a spell. inputs: { caster, spell, slotLevel?, target?, ... }\n' +
      '- use_resource: spend a limited-use feature charge. inputs: { actor, resource, amount? }\n' +
      '- equip_focus / unequip_focus: equip or unequip a spellcasting focus. inputs: { actor, item? }\n' +
      '- attune / unattune: attune or detach from a magic item. inputs: { actor, item }',
    SPELL_SUBACTIONS,
    {
      caster: { type: 'string', description: 'Caster actor ID' },
      spell: { type: 'string', description: 'Spell slug' },
      slotLevel: { type: 'integer', description: 'Spell slot level to consume' },
      target: { type: 'string', description: 'Target actor ID' },
      actor: { type: 'string', description: 'Actor ID' },
      resource: { type: 'string', description: 'Feature/resource slug' },
      amount: { type: 'integer' },
      item: { type: 'string', description: 'Item slug (focus / magic item)' },
    },
  ),
  metaTool(
    'inventory_action',
    'Inventory manipulation:\n' +
      '- add_item: add a SRD item to inventory. inputs: { actor, slug, qty? }\n' +
      '- remove_item: remove an item. inputs: { actor, slug, qty? }\n' +
      '- add_narrative_item: add a custom one-of-a-kind narrative item. inputs: { actor, name, description }\n' +
      '- equip / unequip: equip or unequip a weapon/armor/shield. inputs: { actor, slug, slot? }\n' +
      '- recompute_ac: re-derive AC from current equipped gear. inputs: { actor }',
    INVENTORY_SUBACTIONS,
    {
      actor: { type: 'string', description: 'Actor ID' },
      slug: { type: 'string', description: 'SRD item slug' },
      qty: { type: 'integer', description: 'Quantity' },
      name: { type: 'string', description: 'Item name (narrative items only)' },
      description: { type: 'string', description: 'Narrative item description' },
      slot: { type: 'string', description: 'Equipment slot' },
    },
  ),
  metaTool(
    'character_action',
    'Character-progression and feature actions:\n' +
      '- level_up: advance to next character level. inputs: { actor }\n' +
      '- add_class_level: multi-class into a new class. inputs: { actor, className }\n' +
      '- award_xp: grant XP. inputs: { actors[], amount }\n' +
      '- grant_inspiration / spend_inspiration: PHB Inspiration token. inputs: { actor }\n' +
      '- use_class_feature: generic class-feature usage. inputs: { actor, feature, ... }\n' +
      '- start_rage / end_rage: Barbarian Rage. inputs: { actor }\n' +
      '- use_action_surge: Fighter Action Surge. inputs: { actor }\n' +
      '- use_channel_divinity: Cleric/Paladin Channel Divinity. inputs: { actor, option? }\n' +
      '- grant_bardic_inspiration: Bardic Inspiration die. inputs: { source, target }\n' +
      '- use_lay_on_hands: Paladin Lay on Hands healing pool. inputs: { actor, target, hp }',
    CHARACTER_SUBACTIONS,
    {
      actor: { type: 'string', description: 'Actor ID' },
      className: { type: 'string', description: 'Class slug (for multiclass)' },
      actors: { type: 'array', items: { type: 'string' }, description: 'Actor IDs (for award_xp)' },
      amount: { type: 'integer', description: 'XP amount' },
      feature: { type: 'string', description: 'Class feature slug' },
      option: { type: 'string', description: 'Subfeature option' },
      source: { type: 'string', description: 'Source actor (bardic inspiration)' },
      target: { type: 'string', description: 'Target actor ID' },
      hp: { type: 'integer', description: 'HP to spend (lay on hands)' },
    },
  ),
  metaTool(
    'rest_action',
    'Rest mechanics:\n' +
      '- short_rest: PHB short rest (1h, hit dice). inputs: { actors[] }\n' +
      '- long_rest: PHB long rest (8h, full HP/slot reset). inputs: { actors[] }',
    REST_SUBACTIONS,
    {
      actors: { type: 'array', items: { type: 'string' }, description: 'Actor IDs taking the rest' },
    },
  ),
  metaTool(
    'narrative_action',
    'Narrative & query actions that always available:\n' +
      '- lookup_codex: look up a codex entity (NPC, location, lore). inputs: { query }\n' +
      '- set_current_player: hand the turn to another party member. inputs: { characterId }\n' +
      '- take_action: free-form non-combat action that needs engine tracking. inputs: { actor, description }\n' +
      '- ability_check: ability or skill check with DC. inputs: { actor, ability|skill, dc, useInspiration? }\n' +
      '- saving_throw: saving throw with DC. inputs: { actor, ability, dc }\n' +
      '- roll_dice: arbitrary formula like "3d6+2". inputs: { formula }\n' +
      '- roll_d20: single d20 with optional modifier. inputs: { modifier?, advantage?, disadvantage? }\n' +
      '- update_npc_beats: track NPC three-beat narrative arc. inputs: { npcId, beat }',
    NARRATIVE_SUBACTIONS,
    {
      query: { type: 'string', description: 'Codex query string' },
      characterId: { type: 'string', description: 'Character ID (set_current_player)' },
      actor: { type: 'string', description: 'Actor ID' },
      description: { type: 'string', description: 'Action description (take_action)' },
      ability: { type: 'string', description: 'Ability (STR/DEX/CON/INT/WIS/CHA)' },
      skill: { type: 'string', description: 'Skill name (perception, athletics, ...)' },
      dc: { type: 'integer', description: 'Difficulty Class' },
      useInspiration: { type: 'boolean' },
      formula: { type: 'string', description: 'Dice formula (e.g. 3d6+2)' },
      modifier: { type: 'integer', description: 'd20 modifier' },
      advantage: { type: 'boolean' },
      disadvantage: { type: 'boolean' },
      npcId: { type: 'string', description: 'NPC ID for beat tracking' },
      beat: { type: 'string', description: 'NPC narrative beat' },
    },
  ),
  metaTool(
    'environment_action',
    'Environment & travel:\n' +
      '- set_travel_pace / set_light_level / set_marching_order / set_senses: party-level state\n' +
      '- check_vision: vision check against ambient. inputs: { actor, dc? }\n' +
      '- forced_march: forced-march exhaustion. inputs: { actors[], hours }\n' +
      '- apply_starvation / apply_dehydration / apply_suffocation: environment damage. inputs: { actor, ... }',
    ENVIRONMENT_SUBACTIONS,
    {
      actor: { type: 'string', description: 'Actor ID' },
      actors: { type: 'array', items: { type: 'string' }, description: 'Actor IDs (forced_march)' },
      dc: { type: 'integer', description: 'Difficulty Class' },
      hours: { type: 'integer', description: 'Hours of forced march' },
      pace: { type: 'string', description: 'Travel pace (slow/normal/fast)' },
      light: { type: 'string', description: 'Light level (bright/dim/dark)' },
      order: { type: 'array', items: { type: 'string' }, description: 'Marching order actor IDs' },
      senses: { type: 'array', items: { type: 'string' }, description: 'Active senses' },
      amount: { type: 'integer' },
    },
  ),
  metaTool(
    'meta_action',
    'Campaign-level meta actions (use sparingly — most turns don\'t need these):\n' +
      '- set_tonal_frame / set_engagement_profile: campaign tone tracking\n' +
      '- start_crafting / progress_crafting / complete_crafting / cancel_crafting: crafting workflow\n' +
      '- start_downtime_activity / complete_downtime_activity: downtime workflow\n' +
      '- hire / dismiss_hireling: hireling management\n' +
      '- set_bastion / add_bastion_room: bastion management\n' +
      '- mount / dismount / set_mount_mode: mount control\n' +
      '- embark_vehicle / disembark_vehicle: vehicle control',
    META_SUBACTIONS,
    {
      frame: {
        type: 'string',
        description: 'Tonal frame (high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk)',
      },
      profile: {
        type: 'array',
        items: { type: 'string' },
        description: 'Engagement profile tags',
      },
      actor: { type: 'string', description: 'Actor ID' },
      characterId: { type: 'string' },
      recipe: { type: 'string', description: 'Crafting recipe slug' },
      craftId: { type: 'string', description: 'In-progress crafting ID' },
      activity: { type: 'string', description: 'Downtime activity slug' },
      npc: { type: 'string', description: 'NPC ID (hireling/bastion)' },
      hireling: { type: 'string' },
      bastion: { type: 'string', description: 'Bastion slug' },
      room: { type: 'string', description: 'Bastion room slug' },
      mount: { type: 'string', description: 'Mount entity ID' },
      vehicle: { type: 'string', description: 'Vehicle entity ID' },
      mode: { type: 'string', description: 'Mount/vehicle mode' },
    },
  ),
];
