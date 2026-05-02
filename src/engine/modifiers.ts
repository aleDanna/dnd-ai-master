import type { Ability, Character, Skill } from './types';

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

const PB_BY_LEVEL: Record<number, number> = {
  1: 2,  2: 2,  3: 2,  4: 2,
  5: 3,  6: 3,  7: 3,  8: 3,
  9: 4, 10: 4, 11: 4, 12: 4,
  13: 5, 14: 5, 15: 5, 16: 5,
  17: 6, 18: 6, 19: 6, 20: 6,
};

export function proficiencyBonusForLevel(level: number): number {
  if (level < 1 || level > 20) throw new Error(`proficiencyBonusForLevel: level out of range (${level})`);
  return PB_BY_LEVEL[level]!;
}

export function savingThrowBonus(c: Character, ability: Ability): number {
  const base = abilityModifier(c.abilities[ability]);
  const proficient = c.proficiencies.saves.includes(ability);
  return base + (proficient ? c.proficiencyBonus : 0);
}

const SKILL_ABILITY: Record<Skill, Ability> = {
  'Acrobatics': 'DEX', 'Animal Handling': 'WIS', 'Arcana': 'INT',
  'Athletics': 'STR', 'Deception': 'CHA', 'History': 'INT',
  'Insight': 'WIS', 'Intimidation': 'CHA', 'Investigation': 'INT',
  'Medicine': 'WIS', 'Nature': 'INT', 'Perception': 'WIS',
  'Performance': 'CHA', 'Persuasion': 'CHA', 'Religion': 'INT',
  'Sleight of Hand': 'DEX', 'Stealth': 'DEX', 'Survival': 'WIS',
};

export function skillBonus(c: Character, skill: Skill): number {
  const ability = SKILL_ABILITY[skill];
  const base = abilityModifier(c.abilities[ability]);
  const proficient = c.proficiencies.skills.includes(skill);
  const expert = c.proficiencies.expertise.includes(skill);
  const profMult = expert ? 2 : proficient ? 1 : 0;
  return base + profMult * c.proficiencyBonus;
}

export function passiveScore(
  c: Character,
  skill: Skill,
  opts: { advantage?: boolean; disadvantage?: boolean } = {},
): number {
  const adv = !!opts.advantage && !opts.disadvantage;
  const dis = !!opts.disadvantage && !opts.advantage;
  const adjustment = adv ? 5 : dis ? -5 : 0;
  return 10 + skillBonus(c, skill) + adjustment;
}

export interface AttackProfile {
  profGroup: string;        // proficiency group name e.g. "Martial" or weapon slug
  useDex: boolean;          // true for ranged or finesse used as DEX
}

export function attackBonus(c: Character, profile: AttackProfile): number {
  const abilityMod = abilityModifier(profile.useDex ? c.abilities.DEX : c.abilities.STR);
  const proficient = c.proficiencies.weapons.some((w) => w === profile.profGroup);
  return abilityMod + (proficient ? c.proficiencyBonus : 0);
}

export function spellSaveDC(c: Character): number {
  if (!c.spellcasting) throw new Error(`spellSaveDC: ${c.name} is not a spellcaster`);
  const mod = abilityModifier(c.abilities[c.spellcasting.ability]);
  return 8 + c.proficiencyBonus + mod;
}

export function spellAttackBonus(c: Character): number {
  if (!c.spellcasting) throw new Error(`spellAttackBonus: ${c.name} is not a spellcaster`);
  const mod = abilityModifier(c.abilities[c.spellcasting.ability]);
  return c.proficiencyBonus + mod;
}
