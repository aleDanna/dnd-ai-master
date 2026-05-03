import type { Ability, Character, Skill } from '@/engine/types';
import type { SrdBackground } from '@/db/schema';
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

export interface DeriveContext {
  background?: SrdBackground;
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
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 1,
    hitDieSize,
  };
}
