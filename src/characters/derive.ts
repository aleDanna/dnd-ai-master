import type { Ability, Character, Skill, SpellcastingState } from '@/engine/types';
import type { SrdBackground, SrdClass, SrdRace } from '@/db/schema';
import { abilityModifier, proficiencyBonusForLevel } from '@/engine/modifiers';
import type { WizardState } from './types';

const HIT_DIE_FOR_CLASS: Record<string, number> = {
  barbarian: 12,
  fighter: 10, paladin: 10, ranger: 10,
  bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8,
  sorcerer: 6, wizard: 6,
};

const SAVES_FOR_CLASS: Record<string, Ability[]> = {
  barbarian: ['STR', 'CON'],
  bard: ['DEX', 'CHA'],
  cleric: ['WIS', 'CHA'],
  druid: ['INT', 'WIS'],
  fighter: ['STR', 'CON'],
  monk: ['STR', 'DEX'],
  paladin: ['WIS', 'CHA'],
  ranger: ['STR', 'DEX'],
  rogue: ['DEX', 'INT'],
  sorcerer: ['CON', 'CHA'],
  warlock: ['WIS', 'CHA'],
  wizard: ['INT', 'WIS'],
};

// Spellcasting ability per class. Classes that don't cast at all (barbarian,
// fighter, monk, rogue) are absent. Paladin and ranger are full classes that
// gain spellcasting at level 2 — they're listed so the field is populated
// when they later level up, but at L1 they have no slots.
const SPELL_ABILITY_FOR_CLASS: Record<string, Ability> = {
  bard: 'CHA',
  cleric: 'WIS',
  druid: 'WIS',
  paladin: 'CHA',
  ranger: 'WIS',
  sorcerer: 'CHA',
  warlock: 'CHA',
  wizard: 'INT',
};

// Level-1 slot tables. Full casters get 2× L1 slots. Warlock (pact magic)
// gets a single L1 slot at L1. Half-casters don't cast at L1.
const L1_SLOTS_FOR_CLASS: Record<string, Partial<Record<1|2|3|4|5|6|7|8|9, number>>> = {
  bard: { 1: 2 },
  cleric: { 1: 2 },
  druid: { 1: 2 },
  sorcerer: { 1: 2 },
  warlock: { 1: 1 },
  wizard: { 1: 2 },
  // paladin / ranger: no slots at L1
};

// Curated starter spell list per caster class at level 1. Spells are SRD
// slugs that the SRD CSV verifies exist. The wizard PC creation flow does
// not yet ask the player to pick spells, so we grant a sensible default
// loadout — the master can grant or swap entries via narrative later.
// `spellsPrepared` is the subset that's actually castable today; for
// know-everything casters (sorcerer, warlock, bard) it equals known.
const STARTER_SPELLS_FOR_CLASS: Record<string, { known: string[]; prepared: string[] }> = {
  bard: {
    known: ['vicious-mockery', 'mage-hand', 'cure-wounds', 'healing-word', 'faerie-fire', 'thunderwave'],
    prepared: ['vicious-mockery', 'mage-hand', 'cure-wounds', 'healing-word', 'faerie-fire', 'thunderwave'],
  },
  cleric: {
    known: ['sacred-flame', 'guidance', 'light', 'cure-wounds', 'bless', 'guiding-bolt', 'healing-word'],
    prepared: ['sacred-flame', 'guidance', 'light', 'cure-wounds', 'bless', 'guiding-bolt'],
  },
  druid: {
    known: ['druidcraft', 'produce-flame', 'cure-wounds', 'entangle', 'faerie-fire', 'goodberry'],
    prepared: ['druidcraft', 'produce-flame', 'cure-wounds', 'entangle', 'goodberry'],
  },
  sorcerer: {
    known: ['fire-bolt', 'mage-hand', 'light', 'prestidigitation', 'magic-missile', 'shield'],
    prepared: ['fire-bolt', 'mage-hand', 'light', 'prestidigitation', 'magic-missile', 'shield'],
  },
  warlock: {
    known: ['eldritch-blast', 'mage-hand', 'witch-bolt', 'charm-person'],
    prepared: ['eldritch-blast', 'mage-hand', 'witch-bolt', 'charm-person'],
  },
  wizard: {
    known: ['fire-bolt', 'mage-hand', 'prestidigitation', 'magic-missile', 'shield', 'mage-armor', 'detect-magic', 'sleep', 'feather-fall'],
    prepared: ['fire-bolt', 'mage-hand', 'prestidigitation', 'magic-missile', 'shield', 'mage-armor', 'detect-magic'],
  },
  // paladin/ranger: no L1 spells
  paladin: { known: [], prepared: [] },
  ranger: { known: [], prepared: [] },
};

export function deriveLevel1Spellcasting(classSlug: string, abilities: Record<Ability, number>, proficiencyBonus: number): SpellcastingState | null {
  const ability = SPELL_ABILITY_FOR_CLASS[classSlug];
  if (!ability) return null;
  const mod = Math.floor((abilities[ability] - 10) / 2);
  const starter = STARTER_SPELLS_FOR_CLASS[classSlug] ?? { known: [], prepared: [] };
  return {
    ability,
    spellSaveDC: 8 + proficiencyBonus + mod,
    spellAttackBonus: proficiencyBonus + mod,
    slotsMax: L1_SLOTS_FOR_CLASS[classSlug] ?? {},
    spellsKnown: starter.known,
    spellsPrepared: starter.prepared,
  };
}

export interface DeriveContext {
  background?: SrdBackground;
  /** @deprecated unused — derive reads from wizard.raceSlug. Kept for legacy test compat. */
  race?: SrdRace;
  /** @deprecated unused — derive reads from wizard.subraceSlug. Kept for legacy test compat. */
  parentRace?: SrdRace;
  /** @deprecated unused — derive reads from wizard.classSlug. Kept for legacy test compat. */
  klass?: SrdClass;
}

/** Pure derivation. NO DB writes; the persistence layer (Task 22) does that. */
export function deriveCharacter(wizard: WizardState, context: DeriveContext = {}): Omit<Character, 'id'> {
  if (!wizard.raceSlug || !wizard.classSlug || !wizard.backgroundSlug) {
    throw new Error('deriveCharacter: incomplete wizard state');
  }
  const level = 1;
  const hitDieSize = HIT_DIE_FOR_CLASS[wizard.classSlug] ?? 8;
  const conMod = abilityModifier(wizard.abilities.CON);
  const dexMod = abilityModifier(wizard.abilities.DEX);
  const hpMax = hitDieSize + conMod;
  const proficiencyBonus = proficiencyBonusForLevel(level);
  const saves = SAVES_FOR_CLASS[wizard.classSlug] ?? [];

  // Merge wizard-picked skills with background-granted skills (de-duplicated, preserves order).
  // The SRD CSVs use the canonical D&D 5e skill names, so casting to Skill[] is safe.
  const backgroundSkills = (context.background?.skillProficiencies ?? []) as Skill[];
  const skills = Array.from(new Set([...wizard.skills, ...backgroundSkills]));

  return {
    name: wizard.identity.name || 'Unnamed',
    level,
    xp: 0,
    classSlug: wizard.classSlug,
    raceSlug: wizard.raceSlug,
    backgroundSlug: wizard.backgroundSlug,
    abilities: wizard.abilities,
    proficiencyBonus,
    hpMax,
    ac: 10 + dexMod,                    // pre-equipment placeholder
    speed: 30,                           // race-specific override could apply later
    proficiencies: {
      saves,
      skills,
      expertise: [],
      weapons: [],
      armor: [],
      tools: [],
      languages: ['Common'],
    },
    spellcasting: deriveLevel1Spellcasting(wizard.classSlug, wizard.abilities, proficiencyBonus),
    features: [],
    inventory: [],
    hitDiceMax: 1,
    hitDieSize,
  };
}
