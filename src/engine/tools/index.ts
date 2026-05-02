import type { AnthropicTool } from '../types';
import { ABILITY_ENUM, SKILL_ENUM, DAMAGE_TYPE_ENUM, CONDITION_ENUM, ACTOR_ID } from './schemas';

export const TOOL_DEFINITIONS: AnthropicTool[] = [
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
    description: 'End the current combat turn and advance to the next actor in initiative order.',
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
];
