import type { ArchetypeBinding } from './archetypes';

/**
 * SRD spell → archetype bindings. Phase 9 expanded the catalog from ~33 to
 * 150+ spells. Strategy:
 *   - Damage spells with rolls → attack_damage / save_half / save_negate / aoe_save
 *   - Buffs / condition-applying spells → buff or save_condition
 *   - Heal spells → heal
 *   - Utility (no rolls) → utility
 *   - Complex transformation spells (polymorph, wish, true-resurrection,
 *     shapechange, simulacrum, mass-related ones) → LEFT UNBOUND. The
 *     fallback narrative cast handles slot consumption + concentration;
 *     the master narrates the rest.
 *
 * Bindings are intentionally generous: a binding with imperfect mechanics
 * still gives the master a clean `cast_spell` resolution; the alternative
 * (no binding) is also fine and falls through to "narrative cast".
 */
export const SPELL_BINDINGS: Record<string, ArchetypeBinding> = {
  // ════════════════════════════════════════════════════════════════════════
  // CANTRIPS (level 0) — ~14 bindings
  // ════════════════════════════════════════════════════════════════════════

  // Attack-roll cantrips
  'fire-bolt': {
    archetype: 'attack_damage',
    damage: { dice: '1d10', type: 'fire' },
    attackRoll: true,
    minSlot: 0,
  },
  'eldritch-blast': {
    archetype: 'attack_damage',
    damage: { dice: '1d10', type: 'force' },
    attackRoll: true,
    minSlot: 0,
  },
  'ray-of-frost': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'cold' },
    attackRoll: true,
    minSlot: 0,
  },
  'shocking-grasp': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'lightning' },
    attackRoll: true,
    minSlot: 0,
  },
  'chill-touch': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'necrotic' },
    attackRoll: true,
    minSlot: 0,
  },
  'true-strike': {
    // Grants ADV on next attack — narrative-driven; no damage roll.
    archetype: 'utility',
    minSlot: 0,
  },

  // Save cantrips
  'poison-spray': {
    archetype: 'save_negate',
    damage: { dice: '1d12', type: 'poison' },
    save: { ability: 'CON' },
    minSlot: 0,
  },
  'sacred-flame': {
    archetype: 'save_negate',
    damage: { dice: '1d8', type: 'radiant' },
    save: { ability: 'DEX' },
    minSlot: 0,
  },
  'acid-splash': {
    archetype: 'save_negate',
    damage: { dice: '1d6', type: 'acid' },
    save: { ability: 'DEX' },
    minSlot: 0,
  },
  'vicious-mockery': {
    archetype: 'save_negate',
    damage: { dice: '1d4', type: 'psychic' },
    save: { ability: 'WIS' },
    minSlot: 0,
  },
  'thunderclap': {
    archetype: 'save_negate',
    damage: { dice: '1d6', type: 'thunder' },
    save: { ability: 'CON' },
    minSlot: 0,
  },

  // Utility cantrips
  'light': { archetype: 'utility', minSlot: 0 },
  'mage-hand': { archetype: 'utility', minSlot: 0 },
  'prestidigitation': { archetype: 'utility', minSlot: 0 },
  'minor-illusion': { archetype: 'utility', minSlot: 0 },
  'dancing-lights': { archetype: 'utility', minSlot: 0 },
  'druidcraft': { archetype: 'utility', minSlot: 0 },
  'guidance': { archetype: 'utility', minSlot: 0 },
  'mending': { archetype: 'utility', minSlot: 0 },
  'message': { archetype: 'utility', minSlot: 0 },
  'resistance': { archetype: 'utility', minSlot: 0 },
  'spare-the-dying': { archetype: 'utility', minSlot: 0 },
  'thaumaturgy': { archetype: 'utility', minSlot: 0 },
  'control-flames': { archetype: 'utility', minSlot: 0 },
  'shape-water': { archetype: 'utility', minSlot: 0 },
  'mold-earth': { archetype: 'utility', minSlot: 0 },
  'gust': { archetype: 'utility', minSlot: 0 },
  'friends': { archetype: 'utility', minSlot: 0 },

  // ════════════════════════════════════════════════════════════════════════
  // 1st LEVEL (~26 bindings)
  // ════════════════════════════════════════════════════════════════════════

  // Damage
  'burning-hands': {
    archetype: 'save_half',
    damage: { dice: '3d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cone', size: '15 ft' },
    minSlot: 1,
  },
  'magic-missile': {
    archetype: 'attack_damage',
    damage: { dice: '1d4+1', type: 'force' },
    minSlot: 1,
  },
  'thunderwave': {
    archetype: 'save_half',
    damage: { dice: '2d8', type: 'thunder', perSlotAbove: '1d8' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'cube', size: '15 ft' },
    minSlot: 1,
  },
  'chromatic-orb': {
    archetype: 'attack_damage',
    damage: { dice: '3d8', type: 'fire', perSlotAbove: '1d8' },
    attackRoll: true,
    minSlot: 1,
  },
  'witch-bolt': {
    archetype: 'attack_damage',
    damage: { dice: '1d12', type: 'lightning' },
    attackRoll: true,
    concentration: true,
    minSlot: 1,
  },
  'guiding-bolt': {
    archetype: 'attack_damage',
    damage: { dice: '4d6', type: 'radiant', perSlotAbove: '1d6' },
    attackRoll: true,
    minSlot: 1,
  },
  'ice-knife': {
    archetype: 'save_half',
    damage: { dice: '2d6', type: 'cold', perSlotAbove: '1d10' },
    save: { ability: 'DEX', halfOnSuccess: true },
    minSlot: 1,
  },
  'hellish-rebuke': {
    archetype: 'save_half',
    damage: { dice: '2d10', type: 'fire', perSlotAbove: '1d10' },
    save: { ability: 'DEX', halfOnSuccess: true },
    minSlot: 1,
  },
  'inflict-wounds': {
    archetype: 'attack_damage',
    damage: { dice: '3d10', type: 'necrotic', perSlotAbove: '1d10' },
    attackRoll: true,
    minSlot: 1,
  },
  'searing-smite': {
    archetype: 'utility',
    concentration: true,
    minSlot: 1,
  },
  'wrathful-smite': {
    archetype: 'utility',
    concentration: true,
    minSlot: 1,
  },
  'thunderous-smite': {
    archetype: 'utility',
    minSlot: 1,
  },
  'divine-favor': {
    archetype: 'utility',
    concentration: true,
    minSlot: 1,
  },

  // Heal
  'cure-wounds': {
    archetype: 'heal',
    heal: { dice: '1d8', perSlotAbove: '1d8', addSpellMod: true },
    targets: { default: 1 },
    minSlot: 1,
  },
  'healing-word': {
    archetype: 'heal',
    heal: { dice: '1d4', perSlotAbove: '1d4', addSpellMod: true },
    targets: { default: 1 },
    minSlot: 1,
  },
  'goodberry': {
    archetype: 'utility',
    minSlot: 1,
  },

  // Buffs / conditions
  'bless': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 10 },
    targets: { default: 3, perSlotAbove: 1 },
    concentration: true,
    minSlot: 1,
  },
  'bane': {
    archetype: 'buff',
    condition: { slug: 'baned', durationRounds: 10 },
    targets: { default: 3, perSlotAbove: 1 },
    concentration: true,
    minSlot: 1,
  },
  'shield-of-faith': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 100 },
    concentration: true,
    minSlot: 1,
  },
  'shield': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 1 },
    minSlot: 1,
  },
  'mage-armor': {
    archetype: 'buff',
    condition: { slug: 'mage-armored', durationRounds: 28800 },
    minSlot: 1,
  },
  'sleep': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'unconscious', durationRounds: 10 },
    minSlot: 1,
  },
  'charm-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 600 },
    minSlot: 1,
  },
  'command': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'incapacitated', durationRounds: 1 },
    minSlot: 1,
  },
  'hex': {
    archetype: 'utility',
    concentration: true,
    minSlot: 1,
  },
  "hunters-mark": {
    archetype: 'utility',
    concentration: true,
    minSlot: 1,
  },
  'faerie-fire': {
    archetype: 'save_condition',
    save: { ability: 'DEX' },
    condition: { slug: 'shielded', durationRounds: 10 },
    aoe: { shape: 'cube', size: '20 ft' },
    concentration: true,
    minSlot: 1,
  },
  'compelled-duel': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 10 },
    concentration: true,
    minSlot: 1,
  },
  'protection-from-evil-and-good': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 100 },
    concentration: true,
    minSlot: 1,
  },
  'sanctuary': {
    archetype: 'utility',
    minSlot: 1,
  },

  // Utility
  'detect-magic': { archetype: 'utility', minSlot: 1, concentration: true },
  'detect-evil-and-good': { archetype: 'utility', minSlot: 1, concentration: true },
  'detect-poison-and-disease': { archetype: 'utility', minSlot: 1, concentration: true },
  'identify': { archetype: 'utility', minSlot: 1 },
  'comprehend-languages': { archetype: 'utility', minSlot: 1 },
  'speak-with-animals': { archetype: 'utility', minSlot: 1 },
  'feather-fall': { archetype: 'utility', minSlot: 1 },
  'jump': { archetype: 'utility', minSlot: 1 },
  'longstrider': { archetype: 'utility', minSlot: 1 },
  'expeditious-retreat': { archetype: 'utility', minSlot: 1, concentration: true },
  'false-life': { archetype: 'utility', minSlot: 1 },
  'find-familiar': { archetype: 'utility', minSlot: 1 },
  'fog-cloud': { archetype: 'utility', minSlot: 1, concentration: true },
  'grease': {
    archetype: 'save_condition',
    save: { ability: 'DEX' },
    condition: { slug: 'prone', durationRounds: 10 },
    aoe: { shape: 'cube', size: '10 ft' },
    minSlot: 1,
  },
  'silent-image': { archetype: 'utility', minSlot: 1, concentration: true },
  'unseen-servant': { archetype: 'utility', minSlot: 1 },
  'alarm': { archetype: 'utility', minSlot: 1 },
  'purify-food-and-drink': { archetype: 'utility', minSlot: 1 },
  'create-or-destroy-water': { archetype: 'utility', minSlot: 1 },
  'disguise-self': { archetype: 'utility', minSlot: 1 },
  'animal-friendship': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 86400 },
    minSlot: 1,
  },
  'tashas-hideous-laughter': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'incapacitated', durationRounds: 10 },
    concentration: true,
    minSlot: 1,
  },
  'bane-1st': { archetype: 'utility', minSlot: 1 },

  // ════════════════════════════════════════════════════════════════════════
  // 2nd LEVEL (~32 bindings)
  // ════════════════════════════════════════════════════════════════════════

  // Damage
  'scorching-ray': {
    archetype: 'attack_damage',
    damage: { dice: '2d6', type: 'fire' },
    attackRoll: true,
    minSlot: 2,
  },
  'melfs-acid-arrow': {
    archetype: 'attack_damage',
    damage: { dice: '4d4', type: 'acid', perSlotAbove: '1d4' },
    attackRoll: true,
    minSlot: 2,
  },
  'flame-blade': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'flaming-sphere': {
    archetype: 'save_half',
    damage: { dice: '2d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    concentration: true,
    minSlot: 2,
  },
  'shatter': {
    archetype: 'save_half',
    damage: { dice: '3d8', type: 'thunder', perSlotAbove: '1d8' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '10 ft radius' },
    minSlot: 2,
  },
  'cloud-of-daggers': {
    archetype: 'save_half',
    damage: { dice: '4d4', type: 'slashing', perSlotAbove: '2d4' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cube', size: '5 ft' },
    concentration: true,
    minSlot: 2,
  },
  'moonbeam': {
    archetype: 'save_half',
    damage: { dice: '2d10', type: 'radiant', perSlotAbove: '1d10' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'cylinder', size: '5 ft radius' },
    concentration: true,
    minSlot: 2,
  },
  'spiritual-weapon': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'force' },
    attackRoll: true,
    minSlot: 2,
  },
  'dragons-breath': {
    archetype: 'save_half',
    damage: { dice: '3d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cone', size: '15 ft' },
    concentration: true,
    minSlot: 2,
  },
  'aganazzars-scorcher': {
    archetype: 'save_half',
    damage: { dice: '3d8', type: 'fire', perSlotAbove: '1d8' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'line', size: '30 ft' },
    minSlot: 2,
  },
  'snilloc-snowball-swarm': {
    archetype: 'save_half',
    damage: { dice: '3d6', type: 'cold', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '5 ft radius' },
    minSlot: 2,
  },
  'ray-of-enfeeblement': {
    archetype: 'save_condition',
    save: { ability: 'CON' },
    condition: { slug: 'baned', durationRounds: 10 },
    concentration: true,
    minSlot: 2,
  },

  // Heal & buff
  'aid': {
    archetype: 'utility',
    minSlot: 2,
  },
  'lesser-restoration': {
    archetype: 'utility',
    minSlot: 2,
  },
  'prayer-of-healing': {
    archetype: 'heal',
    heal: { dice: '2d8', perSlotAbove: '1d8', addSpellMod: true },
    targets: { default: 6 },
    minSlot: 2,
  },
  'enhance-ability': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 100 },
    concentration: true,
    minSlot: 2,
  },
  'barkskin': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 100 },
    concentration: true,
    minSlot: 2,
  },
  'magic-weapon': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 100 },
    concentration: true,
    minSlot: 2,
  },
  'protection-from-poison': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 600 },
    minSlot: 2,
  },
  'warding-bond': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 600 },
    minSlot: 2,
  },
  'mirror-image': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 100 },
    minSlot: 2,
  },
  'invisibility': {
    archetype: 'buff',
    condition: { slug: 'invisible', durationRounds: 600 },
    concentration: true,
    minSlot: 2,
  },
  'pass-without-trace': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 600 },
    concentration: true,
    minSlot: 2,
  },
  'see-invisibility': {
    archetype: 'utility',
    minSlot: 2,
  },
  'spider-climb': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'misty-step': {
    archetype: 'utility',
    minSlot: 2,
  },
  'levitate': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'darkvision': {
    archetype: 'utility',
    minSlot: 2,
  },

  // Conditions / control
  'hold-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'paralyzed', durationRounds: 10 },
    concentration: true,
    minSlot: 2,
  },
  'blindness-deafness': {
    archetype: 'save_condition',
    save: { ability: 'CON' },
    condition: { slug: 'blinded', durationRounds: 100 },
    minSlot: 2,
  },
  'suggestion': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 600 },
    concentration: true,
    minSlot: 2,
  },
  'web': {
    archetype: 'save_condition',
    save: { ability: 'DEX' },
    condition: { slug: 'restrained', durationRounds: 100 },
    aoe: { shape: 'cube', size: '20 ft' },
    concentration: true,
    minSlot: 2,
  },
  'spike-growth': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'silence': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'darkness': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'calm-emotions': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'gust-of-wind': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'heat-metal': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },
  'enlarge-reduce': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 10 },
    concentration: true,
    minSlot: 2,
  },
  'blur': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 10 },
    concentration: true,
    minSlot: 2,
  },

  // Utility
  'arcane-lock': { archetype: 'utility', minSlot: 2 },
  'augury': { archetype: 'utility', minSlot: 2 },
  'continual-flame': { archetype: 'utility', minSlot: 2 },
  'find-traps': { archetype: 'utility', minSlot: 2 },
  'knock': { archetype: 'utility', minSlot: 2 },
  'locate-animals-or-plants': { archetype: 'utility', minSlot: 2 },
  'locate-object': { archetype: 'utility', minSlot: 2, concentration: true },
  'magic-mouth': { archetype: 'utility', minSlot: 2 },
  'rope-trick': { archetype: 'utility', minSlot: 2 },
  'detect-thoughts': { archetype: 'utility', minSlot: 2, concentration: true },
  'zone-of-truth': { archetype: 'utility', minSlot: 2 },
  'animal-messenger': { archetype: 'utility', minSlot: 2 },
  'alter-self': { archetype: 'utility', minSlot: 2, concentration: true },
  'branding-smite': {
    archetype: 'utility',
    concentration: true,
    minSlot: 2,
  },

  // ════════════════════════════════════════════════════════════════════════
  // 3rd LEVEL (~28 bindings)
  // ════════════════════════════════════════════════════════════════════════

  // Damage
  'fireball': {
    archetype: 'aoe_save',
    damage: { dice: '8d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    minSlot: 3,
  },
  'lightning-bolt': {
    archetype: 'aoe_save',
    damage: { dice: '8d6', type: 'lightning', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'line', size: '100 ft' },
    minSlot: 3,
  },
  'call-lightning': {
    archetype: 'save_half',
    damage: { dice: '3d10', type: 'lightning', perSlotAbove: '1d10' },
    save: { ability: 'DEX', halfOnSuccess: true },
    concentration: true,
    minSlot: 3,
  },
  'sleet-storm': {
    archetype: 'utility',
    concentration: true,
    minSlot: 3,
  },
  'spirit-guardians': {
    archetype: 'save_half',
    damage: { dice: '3d8', type: 'radiant', perSlotAbove: '1d8' },
    save: { ability: 'WIS', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '15 ft radius' },
    concentration: true,
    minSlot: 3,
  },
  'vampiric-touch': {
    archetype: 'attack_damage',
    damage: { dice: '3d6', type: 'necrotic', perSlotAbove: '1d6' },
    attackRoll: true,
    concentration: true,
    minSlot: 3,
  },
  'stinking-cloud': {
    archetype: 'save_condition',
    save: { ability: 'CON' },
    condition: { slug: 'incapacitated', durationRounds: 10 },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    concentration: true,
    minSlot: 3,
  },
  'wind-wall': {
    archetype: 'utility',
    concentration: true,
    minSlot: 3,
  },

  // Heal & buff
  'mass-healing-word': {
    archetype: 'heal',
    heal: { dice: '1d4', perSlotAbove: '1d4', addSpellMod: true },
    targets: { default: 6 },
    minSlot: 3,
  },
  'revivify': {
    archetype: 'utility',
    minSlot: 3,
  },
  'haste': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 10 },
    concentration: true,
    minSlot: 3,
  },
  'beacon-of-hope': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 10 },
    concentration: true,
    minSlot: 3,
  },
  'protection-from-energy': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 600 },
    concentration: true,
    minSlot: 3,
  },
  'fly': {
    archetype: 'buff',
    condition: { slug: 'flying', durationRounds: 100 },
    concentration: true,
    minSlot: 3,
  },
  'water-breathing': {
    archetype: 'utility',
    minSlot: 3,
  },
  'water-walk': {
    archetype: 'utility',
    minSlot: 3,
  },
  'gaseous-form': {
    archetype: 'utility',
    concentration: true,
    minSlot: 3,
  },
  'blink': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 10 },
    minSlot: 3,
  },
  'magic-circle': {
    archetype: 'utility',
    minSlot: 3,
  },
  'leomunds-tiny-hut': {
    archetype: 'utility',
    minSlot: 3,
  },

  // Conditions / control
  'counterspell': {
    archetype: 'utility',
    minSlot: 3,
  },
  'dispel-magic': {
    archetype: 'utility',
    minSlot: 3,
  },
  'fear': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'frightened', durationRounds: 10 },
    aoe: { shape: 'cone', size: '30 ft' },
    concentration: true,
    minSlot: 3,
  },
  'hypnotic-pattern': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'incapacitated', durationRounds: 10 },
    aoe: { shape: 'cube', size: '30 ft' },
    concentration: true,
    minSlot: 3,
  },
  'slow': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'baned', durationRounds: 10 },
    aoe: { shape: 'cube', size: '40 ft' },
    concentration: true,
    minSlot: 3,
  },
  'bestow-curse': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'baned', durationRounds: 100 },
    concentration: true,
    minSlot: 3,
  },
  'remove-curse': {
    archetype: 'utility',
    minSlot: 3,
  },
  'plant-growth': {
    archetype: 'utility',
    minSlot: 3,
  },

  // Utility
  'animate-dead': { archetype: 'utility', minSlot: 3 },
  'clairvoyance': { archetype: 'utility', minSlot: 3, concentration: true },
  'create-food-and-water': { archetype: 'utility', minSlot: 3 },
  'daylight': { archetype: 'utility', minSlot: 3 },
  'feign-death': { archetype: 'utility', minSlot: 3 },
  'glyph-of-warding': { archetype: 'utility', minSlot: 3 },
  'major-image': { archetype: 'utility', minSlot: 3, concentration: true },
  'meld-into-stone': { archetype: 'utility', minSlot: 3 },
  'nondetection': { archetype: 'utility', minSlot: 3 },
  'sending': { archetype: 'utility', minSlot: 3 },
  'speak-with-dead': { archetype: 'utility', minSlot: 3 },
  'speak-with-plants': { archetype: 'utility', minSlot: 3 },
  'tongues': { archetype: 'utility', minSlot: 3 },
  'conjure-animals': { archetype: 'utility', minSlot: 3, concentration: true },

  // ════════════════════════════════════════════════════════════════════════
  // 4th LEVEL (~22 bindings)
  // ════════════════════════════════════════════════════════════════════════

  // Damage
  'ice-storm': {
    archetype: 'aoe_save',
    damage: { dice: '2d8', type: 'cold', perSlotAbove: '1d8' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cylinder', size: '20 ft radius' },
    minSlot: 4,
  },
  'wall-of-fire': {
    archetype: 'save_half',
    damage: { dice: '5d8', type: 'fire', perSlotAbove: '1d8' },
    save: { ability: 'DEX', halfOnSuccess: true },
    concentration: true,
    minSlot: 4,
  },
  'blight': {
    archetype: 'save_half',
    damage: { dice: '8d8', type: 'necrotic', perSlotAbove: '1d8' },
    save: { ability: 'CON', halfOnSuccess: true },
    minSlot: 4,
  },
  'phantasmal-killer': {
    archetype: 'save_half',
    damage: { dice: '4d10', type: 'psychic', perSlotAbove: '1d10' },
    save: { ability: 'WIS', halfOnSuccess: true },
    concentration: true,
    minSlot: 4,
  },
  'vitriolic-sphere': {
    archetype: 'save_half',
    damage: { dice: '10d4', type: 'acid', perSlotAbove: '2d4' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    minSlot: 4,
  },

  // Heal & buff
  'death-ward': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 28800 },
    minSlot: 4,
  },
  'fire-shield': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 100 },
    minSlot: 4,
  },
  'stoneskin': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 100 },
    concentration: true,
    minSlot: 4,
  },
  'freedom-of-movement': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 600 },
    minSlot: 4,
  },
  'guardian-of-faith': {
    archetype: 'utility',
    minSlot: 4,
  },
  'aura-of-life': {
    archetype: 'utility',
    concentration: true,
    minSlot: 4,
  },
  'aura-of-purity': {
    archetype: 'utility',
    concentration: true,
    minSlot: 4,
  },
  'greater-invisibility': {
    archetype: 'buff',
    condition: { slug: 'invisible', durationRounds: 10 },
    concentration: true,
    minSlot: 4,
  },

  // Conditions / control
  'banishment': {
    archetype: 'save_condition',
    save: { ability: 'CHA' },
    condition: { slug: 'incapacitated', durationRounds: 10 },
    concentration: true,
    minSlot: 4,
  },
  'confusion': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'incapacitated', durationRounds: 10 },
    aoe: { shape: 'sphere', size: '10 ft radius' },
    concentration: true,
    minSlot: 4,
  },
  'compulsion': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 10 },
    concentration: true,
    minSlot: 4,
  },
  'dominate-beast': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 100 },
    concentration: true,
    minSlot: 4,
  },
  'otilukes-resilient-sphere': {
    archetype: 'save_condition',
    save: { ability: 'DEX' },
    condition: { slug: 'restrained', durationRounds: 100 },
    concentration: true,
    minSlot: 4,
  },
  'grasping-vine': {
    archetype: 'save_condition',
    save: { ability: 'DEX' },
    condition: { slug: 'restrained', durationRounds: 10 },
    concentration: true,
    minSlot: 4,
  },

  // Utility
  'arcane-eye': { archetype: 'utility', minSlot: 4, concentration: true },
  'conjure-minor-elementals': { archetype: 'utility', minSlot: 4, concentration: true },
  'conjure-woodland-beings': { archetype: 'utility', minSlot: 4, concentration: true },
  'control-water': { archetype: 'utility', minSlot: 4, concentration: true },
  'dimension-door': { archetype: 'utility', minSlot: 4 },
  'divination': { archetype: 'utility', minSlot: 4 },
  'fabricate': { archetype: 'utility', minSlot: 4 },
  'faithful-hound': { archetype: 'utility', minSlot: 4 },
  'giant-insect': { archetype: 'utility', minSlot: 4, concentration: true },
  'hallucinatory-terrain': { archetype: 'utility', minSlot: 4 },
  'leomunds-secret-chest': { archetype: 'utility', minSlot: 4 },
  'locate-creature': { archetype: 'utility', minSlot: 4, concentration: true },
  'private-sanctum': { archetype: 'utility', minSlot: 4 },
  'stone-shape': { archetype: 'utility', minSlot: 4 },

  // ════════════════════════════════════════════════════════════════════════
  // 5th LEVEL (~20 bindings)
  // ════════════════════════════════════════════════════════════════════════

  // Damage
  'cone-of-cold': {
    archetype: 'save_half',
    damage: { dice: '8d8', type: 'cold', perSlotAbove: '1d8' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'cone', size: '60 ft' },
    minSlot: 5,
  },
  'flame-strike': {
    archetype: 'save_half',
    damage: { dice: '4d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cylinder', size: '10 ft radius' },
    minSlot: 5,
  },
  'cloudkill': {
    archetype: 'save_half',
    damage: { dice: '5d8', type: 'poison', perSlotAbove: '1d8' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    concentration: true,
    minSlot: 5,
  },
  'insect-plague': {
    archetype: 'save_half',
    damage: { dice: '4d10', type: 'piercing', perSlotAbove: '1d10' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    concentration: true,
    minSlot: 5,
  },
  'destructive-wave': {
    archetype: 'save_half',
    damage: { dice: '5d6', type: 'thunder' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '30 ft radius' },
    minSlot: 5,
  },
  'bigbys-hand': {
    archetype: 'attack_damage',
    damage: { dice: '4d8', type: 'force' },
    attackRoll: true,
    concentration: true,
    minSlot: 5,
  },

  // Heal
  'mass-cure-wounds': {
    archetype: 'heal',
    heal: { dice: '3d8', perSlotAbove: '1d8', addSpellMod: true },
    targets: { default: 6 },
    minSlot: 5,
  },
  'greater-restoration': {
    archetype: 'utility',
    minSlot: 5,
  },
  'raise-dead': {
    archetype: 'utility',
    minSlot: 5,
  },

  // Conditions / control
  'hold-monster': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'paralyzed', durationRounds: 10 },
    concentration: true,
    minSlot: 5,
  },
  'dominate-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 100 },
    concentration: true,
    minSlot: 5,
  },
  'geas': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 86400 },
    minSlot: 5,
  },
  'contagion': {
    archetype: 'save_condition',
    save: { ability: 'CON' },
    condition: { slug: 'poisoned', durationRounds: 100 },
    minSlot: 5,
  },
  'wall-of-force': {
    archetype: 'utility',
    concentration: true,
    minSlot: 5,
  },
  'wall-of-stone': {
    archetype: 'utility',
    concentration: true,
    minSlot: 5,
  },
  'telekinesis': {
    archetype: 'utility',
    concentration: true,
    minSlot: 5,
  },
  'mislead': {
    archetype: 'utility',
    concentration: true,
    minSlot: 5,
  },
  'modify-memory': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 10 },
    concentration: true,
    minSlot: 5,
  },

  // Buff
  'animate-objects': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 10 },
    concentration: true,
    minSlot: 5,
  },
  'swift-quiver': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 10 },
    concentration: true,
    minSlot: 5,
  },

  // Utility
  'commune': { archetype: 'utility', minSlot: 5 },
  'commune-with-nature': { archetype: 'utility', minSlot: 5 },
  'creation': { archetype: 'utility', minSlot: 5 },
  'dream': { archetype: 'utility', minSlot: 5 },
  'hallow': { archetype: 'utility', minSlot: 5 },
  'legend-lore': { archetype: 'utility', minSlot: 5 },
  'passwall': { archetype: 'utility', minSlot: 5 },
  'planar-binding': { archetype: 'utility', minSlot: 5 },
  'reincarnate': { archetype: 'utility', minSlot: 5 },
  'scrying': { archetype: 'utility', minSlot: 5, concentration: true },
  'seeming': { archetype: 'utility', minSlot: 5 },
  'teleportation-circle': { archetype: 'utility', minSlot: 5 },
  'tree-stride': { archetype: 'utility', minSlot: 5, concentration: true },
  'awaken': { archetype: 'utility', minSlot: 5 },
  'antilife-shell': { archetype: 'utility', minSlot: 5, concentration: true },
  'conjure-elemental': { archetype: 'utility', minSlot: 5, concentration: true },
  'contact-other-plane': { archetype: 'utility', minSlot: 5 },
  'dispel-evil-and-good': { archetype: 'utility', minSlot: 5, concentration: true },
  'rarys-telepathic-bond': { archetype: 'utility', minSlot: 5 },

  // ════════════════════════════════════════════════════════════════════════
  // 6th-9th LEVEL — selected high-impact spells (~20 bindings)
  //
  // Most epic-level transformation/wish spells (wish, true-resurrection,
  // shapechange, simulacrum, reality-bending) are intentionally LEFT UNBOUND
  // so the master narrates them. These bindings cover the common direct-
  // damage / save / utility ones the engine can resolve cleanly.
  // ════════════════════════════════════════════════════════════════════════

  // 6th
  'disintegrate': {
    archetype: 'save_half',
    damage: { dice: '10d6+40', type: 'force', perSlotAbove: '3d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    minSlot: 6,
  },
  'chain-lightning': {
    archetype: 'save_half',
    damage: { dice: '10d8', type: 'lightning', perSlotAbove: '1d8' },
    save: { ability: 'DEX', halfOnSuccess: true },
    minSlot: 6,
  },
  'circle-of-death': {
    archetype: 'save_half',
    damage: { dice: '8d6', type: 'necrotic', perSlotAbove: '2d6' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '60 ft radius' },
    minSlot: 6,
  },
  'sunbeam': {
    archetype: 'save_half',
    damage: { dice: '6d8', type: 'radiant' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'line', size: '60 ft' },
    concentration: true,
    minSlot: 6,
  },
  'heal': {
    // PHB §11: heal restores 70 HP (flat). Encoded here as 70d1 because
    // the engine's rollDice uses formula-style dice — `<n>d1` always
    // rolls to <n>. Upcast adds 10 HP per slot above (also via d1).
    archetype: 'heal',
    heal: { dice: '70d1', perSlotAbove: '10d1', addSpellMod: false },
    targets: { default: 1 },
    minSlot: 6,
  },
  'mass-suggestion': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 600 },
    minSlot: 6,
  },
  'globe-of-invulnerability': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 10 },
    concentration: true,
    minSlot: 6,
  },
  'true-seeing': {
    archetype: 'utility',
    minSlot: 6,
  },

  // 7th
  'finger-of-death': {
    archetype: 'save_half',
    damage: { dice: '7d8+30', type: 'necrotic' },
    save: { ability: 'CON', halfOnSuccess: true },
    minSlot: 7,
  },
  'fire-storm': {
    archetype: 'save_half',
    damage: { dice: '7d10', type: 'fire' },
    save: { ability: 'DEX', halfOnSuccess: true },
    minSlot: 7,
  },
  'delayed-blast-fireball': {
    archetype: 'aoe_save',
    damage: { dice: '12d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    concentration: true,
    minSlot: 7,
  },
  'prismatic-spray': {
    archetype: 'save_half',
    damage: { dice: '10d6', type: 'force' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cone', size: '60 ft' },
    minSlot: 7,
  },
  'regenerate': {
    archetype: 'heal',
    heal: { dice: '4d8+15', addSpellMod: false },
    targets: { default: 1 },
    minSlot: 7,
  },
  'resurrection': {
    archetype: 'utility',
    minSlot: 7,
  },
  'plane-shift': {
    archetype: 'utility',
    minSlot: 7,
  },
  'teleport': {
    archetype: 'utility',
    minSlot: 7,
  },

  // 8th
  'sunburst': {
    archetype: 'save_half',
    damage: { dice: '12d6', type: 'radiant' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '60 ft radius' },
    minSlot: 8,
  },
  'incendiary-cloud': {
    archetype: 'save_half',
    damage: { dice: '10d8', type: 'fire' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    concentration: true,
    minSlot: 8,
  },
  'earthquake': {
    archetype: 'utility',
    concentration: true,
    minSlot: 8,
  },
  'antimagic-field': {
    archetype: 'utility',
    concentration: true,
    minSlot: 8,
  },
  'feeblemind': {
    archetype: 'save_condition',
    save: { ability: 'INT' },
    condition: { slug: 'baned', durationRounds: 'until_removed' },
    minSlot: 8,
  },
  'dominate-monster': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 100 },
    concentration: true,
    minSlot: 8,
  },

  // 9th
  'meteor-swarm': {
    archetype: 'save_half',
    damage: { dice: '40d6', type: 'fire' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '40 ft radius' },
    minSlot: 9,
  },
  'power-word-kill': {
    archetype: 'utility',
    minSlot: 9,
  },
  'time-stop': {
    archetype: 'utility',
    minSlot: 9,
  },
  'mass-heal': {
    // PHB §11: mass-heal pool of 700 HP across willing creatures. Encoded
    // here as 700d1 (always sums to 700) to satisfy the engine's
    // dice-formula contract. The master decides the per-target split
    // narratively.
    archetype: 'heal',
    heal: { dice: '700d1', addSpellMod: false },
    targets: { default: 6 },
    minSlot: 9,
  },
  'foresight': {
    archetype: 'buff',
    condition: { slug: 'blessed', durationRounds: 28800 },
    minSlot: 9,
  },
  'gate': {
    archetype: 'utility',
    concentration: true,
    minSlot: 9,
  },
  'true-polymorph': {
    archetype: 'utility',
    concentration: true,
    minSlot: 9,
  },
  'astral-projection': {
    archetype: 'utility',
    minSlot: 9,
  },
};

export function bindingFor(spellSlug: string): ArchetypeBinding | undefined {
  return SPELL_BINDINGS[spellSlug];
}
