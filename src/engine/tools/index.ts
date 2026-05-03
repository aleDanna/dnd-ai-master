import type { AnthropicTool } from '../types';
import type { UserPreferences } from '@/db/schema/users';
import { ABILITY_ENUM, SKILL_ENUM, DAMAGE_TYPE_ENUM, CONDITION_ENUM, ACTOR_ID } from './schemas';

const ALWAYS_ON: AnthropicTool[] = [
  {
    name: 'roll_dice',
    description: 'Roll a dice formula like "3d6+2" and return the total. Use only when no other tool fits.',
    input_schema: { type: 'object', required: ['formula'], properties: { formula: { type: 'string' } } } as never,
  },
  {
    name: 'roll_d20',
    description: 'Roll a single d20 with an optional modifier and advantage/disadvantage.',
    input_schema: {
      type: 'object',
      properties: {
        modifier: { type: 'integer', default: 0 },
        advantage: { type: 'boolean', default: false },
        disadvantage: { type: 'boolean', default: false },
      },
    } as never,
  },
  {
    name: 'ability_check',
    description: 'Resolve an ability or skill check with a DC.',
    input_schema: {
      type: 'object',
      required: ['actor', 'dc'],
      properties: {
        actor: ACTOR_ID,
        skill: SKILL_ENUM,
        ability: ABILITY_ENUM,
        dc: { type: 'integer' },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
      },
    } as never,
  },
  {
    name: 'saving_throw',
    description: 'Resolve a saving throw of a given ability against a DC.',
    input_schema: {
      type: 'object',
      required: ['actor', 'ability', 'dc'],
      properties: {
        actor: ACTOR_ID,
        ability: ABILITY_ENUM,
        dc: { type: 'integer' },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
      },
    } as never,
  },
  {
    name: 'roll_initiative',
    description: 'Roll initiative for all PCs and monsters in scene to start combat.',
    input_schema: { type: 'object', properties: {} } as never,
  },
  {
    name: 'make_attack',
    description: 'Resolve a weapon attack from one combatant against another. Returns hit/miss, damage, dice breakdown.',
    input_schema: {
      type: 'object',
      required: ['attacker', 'target', 'weapon'],
      properties: {
        attacker: ACTOR_ID,
        target: ACTOR_ID,
        weapon: {
          type: 'object',
          required: ['name', 'damage', 'damageType', 'profGroup'],
          properties: {
            name: { type: 'string' },
            damage: { type: 'string', description: '"1d8" style' },
            damageType: DAMAGE_TYPE_ENUM,
            profGroup: { type: 'string' },
            useDex: { type: 'boolean' },
          },
        },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
      },
    } as never,
  },
  {
    name: 'apply_damage',
    description: 'Apply damage of a given type to an actor (used for spell damage, environmental, etc.).',
    input_schema: {
      type: 'object',
      required: ['actor', 'amount', 'type'],
      properties: {
        actor: ACTOR_ID,
        amount: { type: 'integer', minimum: 0 },
        type: DAMAGE_TYPE_ENUM,
      },
    } as never,
  },
  {
    name: 'end_turn',
    description: 'End the current combat turn and advance to the next actor in initiative order. Call after each actor (PC or NPC) finishes their actions in a combat round.',
    input_schema: { type: 'object', properties: {} } as never,
  },
  {
    name: 'end_combat',
    description: 'End the active combat and return to exploration mode. Call when all hostile combatants are defeated, surrendered, fled, or otherwise no longer pose a threat. Clears the initiative tracker and the round counter.',
    input_schema: { type: 'object', properties: {} } as never,
  },
  {
    name: 'cast_spell',
    description: 'Cast a spell from the caster\'s known list, consuming a slot.',
    input_schema: {
      type: 'object',
      required: ['caster', 'spellSlug', 'slotLevel'],
      properties: {
        caster: ACTOR_ID,
        spellSlug: { type: 'string' },
        slotLevel: { type: 'integer', minimum: 1, maximum: 9 },
        targets: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: ACTOR_ID } } },
      },
    } as never,
  },
  {
    name: 'apply_condition',
    description: 'Apply a condition to an actor. The duration is in rounds, or "until_removed".',
    input_schema: {
      type: 'object',
      required: ['actor', 'condition', 'source', 'durationRounds'],
      properties: {
        actor: ACTOR_ID,
        condition: CONDITION_ENUM,
        source: { type: 'string', description: 'Narrative source, e.g. "goblin bite"' },
        durationRounds: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['until_removed'] }] },
      },
    } as never,
  },
  {
    name: 'remove_condition',
    description: 'Remove a condition from an actor.',
    input_schema: {
      type: 'object',
      required: ['actor', 'condition'],
      properties: { actor: ACTOR_ID, condition: CONDITION_ENUM },
    } as never,
  },
  {
    name: 'use_resource',
    description: 'Use a class resource (rage, ki, second_wind, action_surge, channel_divinity, etc.).',
    input_schema: {
      type: 'object',
      required: ['actor', 'featureSlug'],
      properties: {
        actor: ACTOR_ID,
        featureSlug: { type: 'string' },
        amount: { type: 'integer', minimum: 1, default: 1 },
      },
    } as never,
  },
  {
    name: 'short_rest',
    description: 'Take a short rest. Optionally spend hit dice to heal.',
    input_schema: {
      type: 'object',
      required: ['actor'],
      properties: { actor: ACTOR_ID, hitDiceSpent: { type: 'integer', minimum: 0 } },
    } as never,
  },
  {
    name: 'long_rest',
    description: 'Take a long rest: full HP, all slots, all resources, half hit dice.',
    input_schema: { type: 'object', required: ['actor'], properties: { actor: ACTOR_ID } } as never,
  },
  {
    name: 'equip',
    description: 'Equip an item from the character\'s inventory.',
    input_schema: { type: 'object', required: ['actor', 'itemSlug'], properties: { actor: ACTOR_ID, itemSlug: { type: 'string' } } } as never,
  },
  {
    name: 'unequip',
    description: 'Unequip an item.',
    input_schema: { type: 'object', required: ['actor', 'itemSlug'], properties: { actor: ACTOR_ID, itemSlug: { type: 'string' } } } as never,
  },
  {
    name: 'recompute_ac',
    description: 'Recompute armor class for a character after equipment changes.',
    input_schema: { type: 'object', required: ['actor'], properties: { actor: ACTOR_ID } } as never,
  },
  {
    name: 'level_up',
    description: 'Level up a PC, computing HP delta. Use rarely — typically out-of-session.',
    input_schema: {
      type: 'object',
      required: ['actor', 'newLevel'],
      properties: {
        actor: ACTOR_ID,
        newLevel: { type: 'integer', minimum: 2, maximum: 20 },
        hpRollMode: { type: 'string', enum: ['average', 'rolled'], default: 'average' },
      },
    } as never,
  },
  {
    name: 'add_item',
    description:
      'Add an item to the player character\'s inventory. Use slugs from the SRD where possible (e.g. "longbow", "leather", "shield", "rope-hempen"). For currency use the standard slugs gp/sp/cp/ep/pp with qty being the amount of coins. Stacks with existing entries of the same slug.',
    input_schema: {
      type: 'object',
      required: ['actor', 'slug'],
      properties: {
        actor: ACTOR_ID,
        slug: { type: 'string', description: 'Item slug or currency code (gp/sp/cp/ep/pp).' },
        qty: { type: 'integer', minimum: 1, default: 1 },
      },
    } as never,
  },
  {
    name: 'remove_item',
    description:
      'Remove some quantity of an item from the player\'s inventory. Use when the player consumes a potion, spends gold, drops gear, etc. The item is dropped from inventory entirely when its qty reaches 0.',
    input_schema: {
      type: 'object',
      required: ['actor', 'slug'],
      properties: {
        actor: ACTOR_ID,
        slug: { type: 'string' },
        qty: { type: 'integer', minimum: 1, default: 1 },
      },
    } as never,
  },
  {
    name: 'award_xp',
    description:
      'Award experience points to the player character. Use after combat victories, completed objectives, or roleplay milestones. Typical values: 25-100 for trivial encounters, 200-500 for moderate, 750+ for hard. The XP bar updates immediately; level-up is a separate explicit step (use level_up when the threshold is crossed).',
    input_schema: {
      type: 'object',
      required: ['actor', 'amount'],
      properties: {
        actor: ACTOR_ID,
        amount: { type: 'integer', minimum: 1, description: 'XP to add to the current total.' },
        reason: { type: 'string', description: 'Short narrative reason (e.g. "defeated the goblin patrol").' },
      },
    } as never,
  },
];

const SCENE_IMAGE_TOOL: AnthropicTool = {
  name: 'generate_scene_image',
  description:
    'Generate an illustration of the current scene. Use sparingly — only when the visual context meaningfully shifts (combat begins, the party enters a new location, a dramatic event reshapes the scene). The image is generated asynchronously and appears in the Scene panel a few seconds after this call returns. Do NOT call more than once every 3-5 turns. Write the visualPrompt in English.',
  input_schema: {
    type: 'object',
    required: ['visualPrompt'],
    properties: {
      visualPrompt: {
        type: 'string',
        description: 'A vivid English description of the scene to draw: subjects, action, setting, atmosphere, lighting. Do NOT include style/medium — the player\'s configured art style is added automatically.',
      },
    },
  } as never,
};

/** Build the tool list for a turn given the user's preferences. */
export function buildToolDefinitions(prefs: Pick<UserPreferences, 'imageGenerationEnabled'>): AnthropicTool[] {
  return prefs.imageGenerationEnabled ? [...ALWAYS_ON, SCENE_IMAGE_TOOL] : ALWAYS_ON;
}

/** @deprecated Use buildToolDefinitions(prefs) instead. Kept only for legacy tests. */
export const TOOL_DEFINITIONS: AnthropicTool[] = ALWAYS_ON;
