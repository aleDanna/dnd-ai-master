import { describe, it, expect } from 'vitest';
import {
  abilityModifier, proficiencyBonusForLevel, attackBonus,
  savingThrowBonus, skillBonus, passiveScore, spellSaveDC, spellAttackBonus,
} from '@/engine/modifiers';
import type { Character } from '@/engine/types';

const sampleFighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'half-elf', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 44, ac: 18, speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'],
    skills: ['Athletics', 'Perception'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    tools: [],
    languages: ['Common', 'Elvish'],
  },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 5, hitDieSize: 10,
};

describe('modifiers', () => {
  it('abilityModifier follows the table (1→-5, 10→0, 14→+2, 20→+5, 30→+10)', () => {
    expect(abilityModifier(1)).toBe(-5);
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(11)).toBe(0);
    expect(abilityModifier(14)).toBe(2);
    expect(abilityModifier(20)).toBe(5);
    expect(abilityModifier(30)).toBe(10);
  });

  it('proficiencyBonusForLevel follows the table', () => {
    expect(proficiencyBonusForLevel(1)).toBe(2);
    expect(proficiencyBonusForLevel(4)).toBe(2);
    expect(proficiencyBonusForLevel(5)).toBe(3);
    expect(proficiencyBonusForLevel(8)).toBe(3);
    expect(proficiencyBonusForLevel(9)).toBe(4);
    expect(proficiencyBonusForLevel(13)).toBe(5);
    expect(proficiencyBonusForLevel(17)).toBe(6);
    expect(proficiencyBonusForLevel(20)).toBe(6);
  });

  it('savingThrowBonus adds proficiency only for proficient saves', () => {
    expect(savingThrowBonus(sampleFighter, 'STR')).toBe(3 /* str mod */ + 3 /* prof */);
    expect(savingThrowBonus(sampleFighter, 'INT')).toBe(0);
  });

  it('skillBonus adds proficiency for proficient skills, doubles for expertise', () => {
    expect(skillBonus(sampleFighter, 'Athletics')).toBe(3 + 3); // STR + prof
    expect(skillBonus(sampleFighter, 'Stealth')).toBe(2);       // DEX only
    const rogueLike: Character = {
      ...sampleFighter,
      proficiencies: { ...sampleFighter.proficiencies, expertise: ['Athletics'] },
    };
    expect(skillBonus(rogueLike, 'Athletics')).toBe(3 + 6);     // STR + 2× prof
  });

  it('passiveScore is 10 + skillBonus + advantage/disadvantage adjustments', () => {
    expect(passiveScore(sampleFighter, 'Perception')).toBe(10 + 1 + 3); // WIS + prof
    expect(passiveScore(sampleFighter, 'Perception', { advantage: true })).toBe(10 + 1 + 3 + 5);
    expect(passiveScore(sampleFighter, 'Perception', { disadvantage: true })).toBe(10 + 1 + 3 - 5);
  });

  it('attackBonus = ability mod + (prof if proficient with weapon)', () => {
    // Longsword (martial), STR-based for Tharion
    expect(attackBonus(sampleFighter, { profGroup: 'Martial', useDex: false })).toBe(3 + 3);
    // Hypothetical weapon Tharion is NOT proficient with
    const noProf: Character = { ...sampleFighter, proficiencies: { ...sampleFighter.proficiencies, weapons: [] } };
    expect(attackBonus(noProf, { profGroup: 'Martial', useDex: false })).toBe(3);
  });

  it('spellSaveDC = 8 + prof + spellcasting ability mod', () => {
    const wizard: Character = {
      ...sampleFighter, classSlug: 'wizard',
      abilities: { ...sampleFighter.abilities, INT: 18 },
      proficiencyBonus: 3,
      spellcasting: { ability: 'INT', spellSaveDC: 0, spellAttackBonus: 0, slotsMax: { 1: 4 }, spellsKnown: [], spellsPrepared: [] },
    };
    expect(spellSaveDC(wizard)).toBe(8 + 3 + 4);
    expect(spellAttackBonus(wizard)).toBe(3 + 4);
  });

  it('spellSaveDC throws when character has no spellcasting', () => {
    expect(() => spellSaveDC(sampleFighter)).toThrow();
  });
});
