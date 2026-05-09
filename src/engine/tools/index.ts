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
    description:
      "Resolve an ability or skill check with a DC. Pass useInspiration:true to spend the PC's Inspiration for ADV on this roll (PHB §18.1, consumed regardless of outcome). Errors with no_inspiration if the PC doesn't have Inspiration.",
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
        useInspiration: {
          type: 'boolean',
          description:
            "PHB §18.1: spend Inspiration for ADV on this check (consumed on first roll, regardless of pass/fail). Errors with no_inspiration if the PC isn't currently inspired.",
        },
      },
    } as never,
  },
  {
    name: 'saving_throw',
    description:
      "Resolve a saving throw of a given ability against a DC. Pass useInspiration:true to spend Inspiration for ADV (PHB §18.1; consumed regardless of outcome).",
    input_schema: {
      type: 'object',
      required: ['actor', 'ability', 'dc'],
      properties: {
        actor: ACTOR_ID,
        ability: ABILITY_ENUM,
        dc: { type: 'integer' },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
        useInspiration: {
          type: 'boolean',
          description:
            'PHB §18.1: spend Inspiration for ADV on this saving throw (consumed regardless of outcome). Errors with no_inspiration if the PC has no Inspiration.',
        },
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
        ranged: { type: 'boolean', description: 'True for ranged weapon attacks. Defaults to false (melee).' },
        meleeRange: { type: 'number', description: 'Melee reach in feet. Defaults to 5. Only consulted when ranged is false.' },
        knockOut: {
          type: 'boolean',
          description:
            'PHB §3.20: melee-only non-lethal blow. If a hit reduces the target to 0 HP, the target falls unconscious instead of triggering death saves. Ranged attacks silently ignore this flag.',
        },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
        useInspiration: {
          type: 'boolean',
          description:
            "PHB §18.1: the attacker spends Inspiration for ADV on this attack (consumed regardless of hit/miss). Errors with no_inspiration if the attacker isn't inspired.",
        },
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
        isCrit: {
          type: 'boolean',
          description:
            'True if the damage is from a critical hit. When the target is already at 0 HP this causes 2 death-save failures instead of 1 (PHB §3.18).',
        },
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
    name: 'take_action',
    description:
      "PHB §3.5: take a standard action (dash, disengage, dodge, help, hide, ready, search, use_object). Consumes the actor's action (or bonus action if useBonusAction=true for Rogue Cunning Action). Hide/Search return rollNeeded — follow up with ability_check for the actual roll. Help applies a 'helped' marker on the beneficiary granting advantage on next d20.",
    input_schema: {
      type: 'object',
      required: ['actor', 'kind'],
      properties: {
        actor: ACTOR_ID,
        kind: {
          type: 'string',
          enum: [
            'dash',
            'disengage',
            'dodge',
            'help',
            'hide',
            'ready',
            'search',
            'use_object',
          ],
        },
        beneficiaryId: {
          type: 'string',
          description: 'For help: the actor receiving advantage on next d20.',
        },
        trigger: {
          type: 'string',
          description: 'For ready: the trigger description.',
        },
        readyAction: {
          type: 'string',
          description: 'For ready: the planned action (e.g. "Attack with bow").',
        },
        dc: {
          type: 'integer',
          description: 'For hide/search: the DC the master assigns (default 10).',
        },
        useBonusAction: {
          type: 'boolean',
          description:
            'Rogue Cunning Action: dash/disengage/hide as bonus action instead of action.',
        },
      },
    } as never,
  },
  {
    name: 'move_to_band',
    description:
      "PHB §3.8: move from current band to a new one. Distance bands: engaged (5ft of an enemy) → near → far → distant. Distances: 5/25/60ft between consecutive bands. Auto-detects opportunity attacks for engagement-leaving (unless actor used Disengage this turn). Consumes movement budget (doubled if Dashed). Returns insufficient_movement if budget exceeded.",
    input_schema: {
      type: 'object',
      required: ['actor', 'toBand'],
      properties: {
        actor: ACTOR_ID,
        toBand: { type: 'string', enum: ['engaged', 'near', 'far', 'distant'] },
        leavesEngagementWith: {
          type: 'array',
          items: { type: 'string' },
          description: 'Enemy IDs whose engagement we leave (triggers OA unless Disengaged)',
        },
        entersEngagementWith: {
          type: 'array',
          items: { type: 'string' },
          description: 'Enemy IDs whose engagement we enter (no OA on us)',
        },
      },
    } as never,
  },
  {
    name: 'cast_spell',
    description: 'Cast a spell from the caster\'s known list. For cantrips pass slotLevel=0 (no slot consumed). For leveled spells pass slotLevel 1-9 (the slot at that level is consumed). When the spell has no built-in mechanical handler the call still succeeds — narrate the effect and call follow-up tools (apply_damage, saving_throw, apply_condition, etc.) for any consequences.',
    input_schema: {
      type: 'object',
      required: ['caster', 'spellSlug', 'slotLevel'],
      properties: {
        caster: ACTOR_ID,
        spellSlug: { type: 'string' },
        slotLevel: { type: 'integer', minimum: 0, maximum: 9, description: '0 for cantrips; 1-9 for leveled spells' },
        targets: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: ACTOR_ID } } },
        asRitual: {
          type: 'boolean',
          description:
            "PHB §8.13: cast the spell as a ritual (10 minutes longer, no slot consumed). Only valid for spells with the ritual tag — the call errors out if the spell isn't a ritual. Defaults to false.",
        },
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
    description:
      "Take a long rest (PHB §5.2): full HP, all slots, all resources, half hit dice, and exhaustion -1. Returns errors when constraints are violated: cannot_rest_at_zero_hp (PC must be at ≥1 HP first — heal or stabilize), long_rest_cooldown (less than 24h since the previous long rest), long_rest_interrupted (interruptedByMinutes ≥ 60 — at least 1 hour of strenuous activity invalidates the rest, party must restart). Stamps the rest's timestamp on session_state for the 24h cooldown.",
    input_schema: {
      type: 'object',
      required: ['actor'],
      properties: {
        actor: ACTOR_ID,
        interruptedByMinutes: {
          type: 'integer',
          minimum: 0,
          description:
            'Minutes of strenuous activity (combat, casting, walking ≥1h) that interrupted the rest. ≥60 invalidates the rest. Default 0.',
        },
      },
    } as never,
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
  {
    name: 'make_death_save',
    description:
      'Roll a death save for an actor at 0 HP. Returns the d20 result and applies the proper success/failure mutation. Natural 20 → regain 1 HP and remove unconscious. Natural 1 → 2 failures. 10+ → success. <10 → failure. 3 successes → stable. 3 failures → dead.',
    input_schema: {
      type: 'object',
      required: ['actorId'],
      properties: {
        actorId: { type: 'string', description: 'ID of the actor at 0 HP making the save.' },
      },
    } as never,
  },
  {
    name: 'stabilize',
    description:
      "Stabilize a dying actor. method='medicine_check' requires medicineRoll (d20 + WIS+Medicine bonus, DC 10). method='healing_kit' auto-stabilizes (consumes 1 use). method='spell' assumes a healing spell already restored ≥1 HP. On success: clears death saves and marks stable; the actor remains unconscious until they regain HP (PHB §3.19).",
    input_schema: {
      type: 'object',
      required: ['actorId', 'method'],
      properties: {
        actorId: { type: 'string', description: 'ID of the dying actor to stabilize.' },
        method: {
          type: 'string',
          enum: ['medicine_check', 'healing_kit', 'spell'],
          description: 'How stabilization is attempted.',
        },
        medicineRoll: {
          type: 'integer',
          description: 'Required if method=medicine_check: total of d20 + Wisdom (Medicine) bonus.',
        },
      },
    } as never,
  },
  {
    name: 'concentration_check',
    description:
      "PHB §8.8: when a concentrating PC takes damage they must succeed on a CON save (DC = max(10, ⌊damage/2⌋)) or lose concentration. Use this tool ONLY in response to a concentration_check mutation emitted by apply_damage. The handler rolls 1d20 + CON modifier + proficiency bonus (if proficient in CON saves); on failure it emits break_concentration with reason='damage'. Errors if the actor is not concentrating.",
    input_schema: {
      type: 'object',
      required: ['actorId', 'dc'],
      properties: {
        actorId: { type: 'string', description: 'ID of the concentrating PC.' },
        dc: {
          type: 'integer',
          description:
            "DC from the concentration_check mutation (already computed by apply_damage as max(10, ⌊damage/2⌋)).",
        },
      },
    } as never,
  },
  {
    name: 'lookup_codex',
    description:
      "Look up a campaign-codex entity by kind + name/slug. Use when an NPC, location, quest, faction, lore fact, named item, or relationship is referenced in chat and is NOT already visible in the Scene card. The codex is the single source of truth for narrative continuity — prefer it over re-inventing details. Returns up to 5 matches; returns an empty array when nothing matches.",
    input_schema: {
      type: 'object',
      required: ['kind', 'query'],
      properties: {
        kind: {
          type: 'string',
          enum: ['npc', 'location', 'quest', 'faction', 'lore_fact', 'named_item', 'relationship'],
        },
        query: {
          type: 'string',
          description: 'Name or slug to look up. Case-insensitive substring match on slug AND name.',
        },
      },
    } as never,
  },
];

/**
 * Build the tool list for a turn. Currently a thin wrapper over `ALWAYS_ON` —
 * the prefs argument is retained for forward-compatibility (e.g. future
 * opt-in tools).
 *
 * Note: scene-image generation USED to live here as a master-callable tool
 * gated on `prefs.imageGenerationEnabled`. It was removed because gpt-5
 * called it too aggressively when given the chance. Image generation is now
 * a manual user action (button in the chat next to Listen).
 */
export function buildToolDefinitions(_prefs: Pick<UserPreferences, 'imageGenerationEnabled'>): AnthropicTool[] {
  return ALWAYS_ON;
}

export const TOOL_DEFINITIONS: AnthropicTool[] = ALWAYS_ON;
