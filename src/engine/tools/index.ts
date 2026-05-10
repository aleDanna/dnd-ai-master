import type { AnthropicTool } from '../types';
import type { UserPreferences } from '@/db/schema/users';
import { ABILITY_ENUM, SKILL_ENUM, DAMAGE_TYPE_ENUM, CONDITION_ENUM, ACTOR_ID } from './schemas';
import { TONAL_FRAMES, ENGAGEMENT_PROFILES, NPC_ATTITUDES } from '../npc-tonal';

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
      "Resolve a saving throw of a given ability against a DC. Pass useInspiration:true to spend Inspiration for ADV (PHB §18.1; consumed regardless of outcome). Pass cover for DEX saves vs AoE through cover (PHB §3.12).",
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
        cover: {
          type: 'string',
          enum: ['none', 'half', 'three-quarters', 'total'],
          description:
            "PHB §3.12: cover the saver sits behind when the AoE comes from the OTHER side. Adds +0/+2/+5 to DEX saves only (other abilities ignore it).",
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
    description: 'Resolve a weapon attack from one combatant against another. Returns hit/miss, damage, dice breakdown. Supports cover (PHB §3.12) and weapon reach/loading/ammunition (PHB §9.4).',
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
            properties: {
              type: 'array',
              items: { type: 'string' },
              description:
                "PHB §9.4 weapon properties (any subset): 'finesse'|'heavy'|'light'|'loading'|'reach'|'thrown'|'two-handed'|'versatile'|'ammunition'. The engine reads 'reach' (10ft melee), 'loading' (one shot/turn), 'ammunition' (consumes ammoSlug).",
            },
            ammoSlug: {
              type: 'string',
              description:
                "PHB §9.4 — inventory slug of the ammunition consumed per attack (when properties includes 'ammunition'). Examples: 'arrow', 'crossbow-bolt'.",
            },
            range: {
              type: 'object',
              properties: {
                normal: { type: 'number' },
                long: { type: 'number' },
              },
              description: 'Range bands in feet for ranged/thrown weapons.',
            },
          },
        },
        ranged: { type: 'boolean', description: 'True for ranged weapon attacks. Defaults to false (melee).' },
        meleeRange: { type: 'number', description: 'Distance in feet to the target. Defaults to weapon reach (5ft / 10ft for reach). Out-of-reach errors with out_of_reach.' },
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
        cover: {
          type: 'string',
          enum: ['none', 'half', 'three-quarters', 'total'],
          description:
            "PHB §3.12: cover protecting the target. half: +2 AC, three-quarters: +5 AC, total: errors target_in_total_cover (no action consumed).",
        },
        offHand: {
          type: 'boolean',
          description:
            "PHB §3.15: this is the bonus-action off-hand attack of two-weapon fighting. Requires weapon has 'light' property and the attacker already used their Attack action this turn. Damage does NOT add ability mod (unless negative).",
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
    description:
      "Cast a spell from the caster's known list. For cantrips pass slotLevel=0 (no slot consumed). For leveled spells pass slotLevel 1-9 (the slot at that level is consumed). When the spell has no built-in mechanical handler the call still succeeds — narrate the effect and call follow-up tools (apply_damage, saving_throw, apply_condition, etc.) for any consequences. PHB §8.3 components are validated BEFORE slot consumption: pass freeHand=false when both hands are visibly occupied AND no focus is held; pass hasMaterial=false when you've narratively decided the costly material is missing. Errors: component_silenced (V required, caster has 'silenced' condition), component_no_free_hand (S required), component_missing_material (M with cost required, not in inventory).",
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
        freeHand: {
          type: 'boolean',
          description:
            "PHB §8.3: caster has at least one free hand for the somatic gesture. Defaults to true. Pass false ONLY when both hands are visibly occupied (e.g., wielding a two-handed weapon AND a shield, or holding a heavy object) AND no focus is held — a focus matching the caster's class (PHB §8.4) replaces the free-hand requirement.",
        },
        hasMaterial: {
          type: 'boolean',
          description:
            "PHB §8.3: caster has the spell's listed material in inventory. Defaults to true (the master assumes possession). Pass false when you've narratively determined the material is missing — costly materials (gp cost or 'consumed') can't be replaced by a focus.",
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
    name: 'add_class_level',
    description:
      "PHB §2.5 Multiclassing: add a level to a PC. If `classSlug` matches an existing class on the PC, that class's level is incremented (re-level — no prereq check). If the slug is a new class, the PC must satisfy BOTH the starting class's AND the new class's ability prereqs (e.g., Wizard requires INT 13, Paladin STR 13 AND CHA 13, Fighter STR 13 OR DEX 13). Errors: `unknown_character`, `invalid_class_slug` (must be one of the 12 PHB classes), `multiclass_prereqs_not_met` (ability score gate failed). Optional `subclass` is persisted on the entry — pass it for Eldritch Knight / Arcane Trickster to drive third-caster spell-slot math.",
    input_schema: {
      type: 'object',
      required: ['character', 'classSlug'],
      properties: {
        character: ACTOR_ID,
        classSlug: {
          type: 'string',
          enum: [
            'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
            'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
          ],
          description: 'One of the 12 PHB classes (lowercase slug).',
        },
        subclass: {
          type: 'string',
          description:
            "Optional subclass / archetype slug (e.g., 'eldritch-knight', 'arcane-trickster'). Persisted on the entry; the master uses it for third-caster slot math.",
        },
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
    name: 'grant_inspiration',
    description:
      "PHB §18.1: DM awards Inspiration to a PC for great roleplaying, a memorable accomplishment, or a heroic moment in the story. Inspiration is a single boolean — \"you either have it or you don't\" (no stacking). Idempotent: granting Inspiration to a PC who already has it is a no-op (returns granted:false). The PC then has Inspiration available to spend on a future d20 roll for ADV (use the useInspiration flag on make_attack / ability_check / saving_throw, or this tool's sibling spend_inspiration).",
    input_schema: {
      type: 'object',
      required: ['character'],
      properties: {
        character: ACTOR_ID,
      },
    } as never,
  },
  {
    name: 'spend_inspiration',
    description:
      "PHB §18.1: spend the PC's Inspiration as a standalone act (e.g. the player declares \"I use my Inspiration\" outside the context of a specific d20 tool call). Most spends should go through the useInspiration flag on make_attack / ability_check / saving_throw, which both applies ADV AND consumes the resource. This standalone tool is for narrative or pre-roll spends. Errors with no_inspiration if the PC doesn't currently have Inspiration.",
    input_schema: {
      type: 'object',
      required: ['character'],
      properties: {
        character: ACTOR_ID,
      },
    } as never,
  },
  {
    name: 'forced_march',
    description:
      "PHB §6.3: when a creature travels for more than 8 hours in a day, it makes a CON saving throw at the end of every additional hour or gains 1 level of exhaustion. The DC is 10 + 1 for each hour past 8. The tool rolls the save (1d20 + CON modifier + proficiency bonus when proficient in CON saves) and emits add_condition('exhaustion') on failure. ≤8 hours = no-op (returns saveSuccess:true with dc:0).",
    input_schema: {
      type: 'object',
      required: ['actor', 'hoursTraveled'],
      properties: {
        actor: ACTOR_ID,
        hoursTraveled: {
          type: 'integer',
          minimum: 0,
          description: 'Total hours of travel that day (including the first 8 free hours).',
        },
      },
    } as never,
  },
  {
    name: 'apply_starvation',
    description:
      "PHB §6.7: a character can survive without food for 3 + CON modifier days (minimum 1). After that threshold, every additional day automatically applies 1 level of exhaustion (NO saving throw). The tool computes the survival threshold from the PC's CON, and emits add_condition('exhaustion') only if daysWithoutFood is past the threshold. Caller is responsible for tracking the running day count.",
    input_schema: {
      type: 'object',
      required: ['actor', 'daysWithoutFood'],
      properties: {
        actor: ACTOR_ID,
        daysWithoutFood: {
          type: 'integer',
          minimum: 0,
          description: 'Cumulative days without food in this bout (1 = end of day 1, 2 = end of day 2, …).',
        },
      },
    } as never,
  },
  {
    name: 'apply_dehydration',
    description:
      "PHB §6.7: a creature drinking less than half the daily water requirement must make a CON saving throw at the end of the day or gain 1 level of exhaustion. The DC is 15 on the first day and increases by 5 per consecutive low-water day. The tool rolls the save (1d20 + CON modifier + proficiency bonus when proficient in CON saves) and emits add_condition('exhaustion') on failure. daysWithLessThanHalfWater < 1 = no-op.",
    input_schema: {
      type: 'object',
      required: ['actor', 'daysWithLessThanHalfWater'],
      properties: {
        actor: ACTOR_ID,
        daysWithLessThanHalfWater: {
          type: 'integer',
          minimum: 0,
          description: 'Number of consecutive days with less than half the daily water requirement.',
        },
      },
    } as never,
  },
  {
    name: 'attune',
    description:
      "PHB §10.1: attune the PC to a magic item they already possess. The bonding takes 1 hour during a short rest — narrate the ritual, then call this tool to record the bond. Errors: unknown_character, item_not_in_inventory (the PC must possess the item, qty ≥ 1, equipped or not), attunement_cap_reached (each PC can be attuned to AT MOST 3 items at once — the player must unattune one first). Idempotent: calling attune on an already-attuned item returns ok with attuned:false (reason:already_attuned), no mutation. The engine does NOT enforce attunement prerequisites (class, race, ability score) — that is the master's responsibility per the item's description.",
    input_schema: {
      type: 'object',
      required: ['character', 'itemSlug'],
      properties: {
        character: ACTOR_ID,
        itemSlug: {
          type: 'string',
          description:
            'Inventory slug of the item being attuned (e.g. "cloak-of-protection"). Must match an entry in the PC inventory with qty ≥ 1.',
        },
      },
    } as never,
  },
  {
    name: 'unattune',
    description:
      "PHB §10.1: break attunement to a magic item. The PC may unattune voluntarily during a long rest, when the item is lost or destroyed, or when they want to free an attunement slot to bond with a new item. Permissive: if the PC isn't currently attuned to the slug the call returns ok with unattuned:false (no error). Cursed-item attunement is hard to break narratively — but mechanically this tool always frees the slot. Use it after the master narrates the breaking of the bond.",
    input_schema: {
      type: 'object',
      required: ['character', 'itemSlug'],
      properties: {
        character: ACTOR_ID,
        itemSlug: { type: 'string' },
      },
    } as never,
  },
  {
    name: 'equip_focus',
    description:
      "PHB §8.4: declare that the PC is currently holding a spellcasting focus. The held focus replaces the somatic free-hand requirement AND substitutes any non-costly material component during cast_spell. Kinds: 'arcane' (orb / rod / staff / wand for sorcerer/warlock/wizard), 'druidic' (sprig of mistletoe / wooden staff / yew wand for druid/ranger), 'holy' (amulet / emblem / reliquary for cleric/paladin), 'instrument' (lute / lyre / drum for bard). The itemSlug must already be in the PC's inventory. Errors: unknown_character, invalid_focus_kind, item_not_in_inventory. The engine does NOT enforce class-vs-kind matching (a fighter can carry an orb) — but at cast time, only a focus matching the caster's class via PHB §8.4 satisfies components.",
    input_schema: {
      type: 'object',
      required: ['character', 'kind', 'itemSlug'],
      properties: {
        character: ACTOR_ID,
        kind: { type: 'string', enum: ['arcane', 'druidic', 'holy', 'instrument'] },
        itemSlug: { type: 'string' },
      },
    } as never,
  },
  {
    name: 'unequip_focus',
    description:
      "PHB §8.4: drop the currently held focus. After this call the PC needs a free hand for somatic components and explicit possession for material components. Idempotent: calling unequip_focus when no focus is set returns ok with unequipped:false (no mutation).",
    input_schema: {
      type: 'object',
      required: ['character'],
      properties: { character: ACTOR_ID },
    } as never,
  },
  {
    name: 'set_travel_pace',
    description:
      "PHB §6.1: set the party's travel pace (Fast/Normal/Slow). Fast = 4 mi/h, 30 mi/day, but -5 to passive Perception (DIS). Normal = 3 mi/h, 24 mi/day, baseline. Slow = 2 mi/h, 18 mi/day, but stealth allowed while travelling. Persists to session_state.travel.pace; merges with any existing travel state (light level, marching order). Errors with invalid_pace if the value isn't fast/normal/slow.",
    input_schema: {
      type: 'object',
      required: ['pace'],
      properties: {
        pace: { type: 'string', enum: ['fast', 'normal', 'slow'] },
      },
    } as never,
  },
  {
    name: 'set_light_level',
    description:
      "PHB §6.4: set the ambient light level for the current scene (bright/dim/darkness). Bright = normal vision. Dim = lightly obscured (DIS on Perception relying on sight unless darkvision). Darkness = heavily obscured (effectively blinded unless darkvision/truesight). Persists to session_state.travel.lightLevel; check_vision honours this default when called without an explicit lightLevel.",
    input_schema: {
      type: 'object',
      required: ['lightLevel'],
      properties: {
        lightLevel: { type: 'string', enum: ['bright', 'dim', 'darkness'] },
      },
    } as never,
  },
  {
    name: 'set_marching_order',
    description:
      "PHB §6.2: record the party's marching order (front/middle/back ranks). Each rank is an array of actor IDs (PC + companions/NPCs). Narrative-only — used for ambush positioning and area-of-effect rulings; the engine does not enforce positional rules from this state.",
    input_schema: {
      type: 'object',
      required: ['order'],
      properties: {
        order: {
          type: 'object',
          required: ['front', 'middle', 'back'],
          properties: {
            front: { type: 'array', items: { type: 'string' } },
            middle: { type: 'array', items: { type: 'string' } },
            back: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    } as never,
  },
  {
    name: 'set_senses',
    description:
      "PHB §6.4: assign special senses to a PC or combat actor. All fields optional and in feet — provide only the senses the actor possesses. darkvisionFt: sees dim as bright and darkness as dim within range (still DIS for Perception in actual darkness). blindsightFt: perceives surroundings without relying on sight. tremorsenseFt: detects creatures touching the same surface. truesightFt: sees through magical and non-magical darkness, invisibility, and illusions within range. passivePerception: optional override (otherwise derived from skill). Branches PC vs combat actor by id.",
    input_schema: {
      type: 'object',
      required: ['actor', 'senses'],
      properties: {
        actor: ACTOR_ID,
        senses: {
          type: 'object',
          properties: {
            darkvisionFt: { type: 'integer', minimum: 0 },
            blindsightFt: { type: 'integer', minimum: 0 },
            tremorsenseFt: { type: 'integer', minimum: 0 },
            truesightFt: { type: 'integer', minimum: 0 },
            passivePerception: { type: 'integer', minimum: 0 },
          },
        },
      },
    } as never,
  },
  {
    name: 'check_vision',
    description:
      "PHB §6.4: programmatically check what an observer can perceive at a given distance under the current (or supplied) light level. Returns { canSee, perceptionDisadvantage, effectivelyBlinded, senseUsed, lightLevel }. Sense priority: blindsight > tremorsense (both bypass light) > truesight (overrides darkness) > darkvision + light (treats dim as bright, darkness as dim) > plain sight. lightLevel optional — defaults to session_state.travel.lightLevel else 'bright'. Pure (no mutation) — caller decides how to apply ADV/DIS to subsequent Perception rolls.",
    input_schema: {
      type: 'object',
      required: ['observer', 'distanceFt'],
      properties: {
        observer: ACTOR_ID,
        distanceFt: { type: 'integer', minimum: 0 },
        lightLevel: {
          type: 'string',
          enum: ['bright', 'dim', 'darkness'],
          description: "Optional override; falls back to state.travel.lightLevel else 'bright'.",
        },
      },
    } as never,
  },
  {
    name: 'apply_falling',
    description:
      "PHB §6.6: apply falling damage. Rolls Math.min(20, floor(distanceFt/10)) d6 bludgeoning and emits apply_damage + add_condition('prone'). Capped at 20d6 (the rules' maximum). distanceFt < 10 is a no-op (returns dice:0, prone:false, no mutations). The DM is responsible for narrating the fall and any resistance/feather-fall negation BEFORE calling — the tool is otherwise unconditional.",
    input_schema: {
      type: 'object',
      required: ['actor', 'distanceFt'],
      properties: {
        actor: ACTOR_ID,
        distanceFt: { type: 'integer', minimum: 0 },
      },
    } as never,
  },
  {
    name: 'apply_suffocation',
    description:
      "PHB §6.5: evaluate suffocation status given seconds without air. Hold-breath = max(30 sec, (1+CON mod)·60 sec). After that, the PC endures CON mod rounds (min 1) at 0 HP before falling unconscious. Returns status: 'ok' (within hold-breath), 'past_breath' (past hold but within post-breath rounds), or 'unconscious' (both windows exhausted — emits set_hp 0 + add_condition unconscious). PC-only.",
    input_schema: {
      type: 'object',
      required: ['actor', 'secondsWithoutAir'],
      properties: {
        actor: ACTOR_ID,
        secondsWithoutAir: { type: 'integer', minimum: 0 },
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
  {
    name: 'set_tonal_frame',
    description:
      "Master World Lore §5.1: pin the campaign's tonal frame. Affects narration style, NPC speech register, combat consequences, magic flavor. 8 frames: high_heroic (LotR triumph), sword_sorcery (Conan/Elric grit), dark (Berserk/Bloodborne futility), mythic (Greek/Witcher cosmic stakes), cosmic_horror (Lovecraft dread), swashbuckling (Princess Bride banter), wuxia (martial schools, ki), steampunk (Eberron magitech). Errors with invalid_tonal_frame for unknown values.",
    input_schema: {
      type: 'object',
      required: ['frame'],
      properties: {
        frame: { type: 'string', enum: TONAL_FRAMES as readonly string[] },
      },
    } as never,
  },
  {
    name: 'set_engagement_profile',
    description:
      "Master Handbook §2.1: register the player's engagement profile(s) detected from their first few turns. Up to multiple values: acting, fighting, instigating, optimizing, problem_solving, storytelling, exploring. Replaces any previous value (call with the FULL up-to-date list). Empty array clears the hint. Errors with invalid_engagement_profile if any entry isn't one of the 7 known profiles.",
    input_schema: {
      type: 'object',
      required: ['profiles'],
      properties: {
        profiles: {
          type: 'array',
          items: { type: 'string', enum: ENGAGEMENT_PROFILES as readonly string[] },
        },
      },
    } as never,
  },
  {
    name: 'update_npc_beats',
    description:
      "Master Handbook §11.1: every NPC needs three beats — Want, Fear, Quirk — plus an Attitude (friendly/indifferent/hostile). Call this whenever you introduce a new NPC or refine their motivations as the story evolves. PARTIAL updates merge with existing values: pass only the fields you want to change. Errors: missing_npc_slug (empty slug), invalid_attitude (attitude not in the 3 known values).",
    input_schema: {
      type: 'object',
      required: ['npcSlug', 'beats'],
      properties: {
        npcSlug: {
          type: 'string',
          description:
            'Slug of the existing NPC codex entry (kind=npc) to update. Match must already exist; the patch is a no-op otherwise.',
        },
        beats: {
          type: 'object',
          properties: {
            want: { type: 'string', description: 'What does this NPC want from this scene? (a coin, a favor, to be left alone, to test the PC)' },
            fear: { type: 'string', description: 'What would make them flee or escalate?' },
            quirk: { type: 'string', description: 'One memorable detail (smells of fish, cracks knuckles, never makes eye contact, laughs at wrong moments).' },
            attitude: { type: 'string', enum: NPC_ATTITUDES as readonly string[] },
          },
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
