import type { ArchetypeBinding } from './archetypes';

export const SPELL_BINDINGS: Record<string, ArchetypeBinding> = {
  // === Cantrips: attack-roll ===
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

  // === 1st-level damage ===
  'burning-hands': {
    archetype: 'save_half',
    damage: { dice: '3d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cone', size: '15 ft' },
    minSlot: 1,
  },
  'magic-missile': {
    // Special: auto-hit, multi-dart. Keep custom handler in spells.ts (binding here marks coverage).
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

  // === 1st-level heal ===
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

  // === 1st-level buff ===
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

  // === 1st-level condition ===
  'sleep': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'unconscious', durationRounds: 10 },
    minSlot: 1,
  },
  'charm-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 600 },  // 1 hour
    minSlot: 1,
  },

  // === 2nd-level ===
  'hold-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'paralyzed', durationRounds: 10 },
    concentration: true,
    minSlot: 2,
  },
  'scorching-ray': {
    archetype: 'attack_damage',
    damage: { dice: '2d6', type: 'fire' },  // per ray; multi-target handled by master
    attackRoll: true,
    minSlot: 2,
  },

  // === 3rd-level ===
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
  'counterspell': {
    archetype: 'utility',
    minSlot: 3,
  },
  'fly': {
    archetype: 'buff',
    condition: { slug: 'flying', durationRounds: 100 },
    concentration: true,
    minSlot: 3,
  },

  // === Utility ===
  'light': { archetype: 'utility', minSlot: 0 },
  'mage-hand': { archetype: 'utility', minSlot: 0 },
  'prestidigitation': { archetype: 'utility', minSlot: 0 },
  'minor-illusion': { archetype: 'utility', minSlot: 0 },
  'detect-magic': { archetype: 'utility', minSlot: 1 },
  'identify': { archetype: 'utility', minSlot: 1 },
  'shield': {
    archetype: 'buff',
    condition: { slug: 'shielded', durationRounds: 1 },
    minSlot: 1,
  },
  'mage-armor': {
    archetype: 'buff',
    condition: { slug: 'mage-armored', durationRounds: 28800 },  // 8 hours
    minSlot: 1,
  },
};

export function bindingFor(spellSlug: string): ArchetypeBinding | undefined {
  return SPELL_BINDINGS[spellSlug];
}
