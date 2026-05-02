import { describe, it, expect } from 'vitest';
import { deriveCharacter } from '@/characters/derive';
import type { WizardState } from '@/characters/types';

const baseWizard: WizardState = {
  raceSlug: 'half-elf',
  classSlug: 'fighter',
  backgroundSlug: 'soldier',
  abilityMethod: 'array',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  skills: ['Athletics', 'Perception'],
  equipmentChoice: 'kit',
  identity: {
    name: 'Tharion',
    alignment: 'True Neutral',
    trait: '', bond: '', flaw: '', backstory: '',
    portraitColor: '#E0B84A',
  },
};

describe('deriveCharacter', () => {
  it('lvl 1 fighter has hpMax = hitDieSize + CON mod = 10 + 2 = 12', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.level).toBe(1);
    expect(d.hpMax).toBe(12);
  });

  it('proficiencyBonus is 2 at level 1', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.proficiencyBonus).toBe(2);
  });

  it('hit die for fighter is d10', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.hitDieSize).toBe(10);
    expect(d.hitDiceMax).toBe(1);
  });

  it('saves include STR and CON for fighter', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.proficiencies.saves).toEqual(expect.arrayContaining(['STR', 'CON']));
  });

  it('skills picked in wizard appear in proficiencies.skills', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.proficiencies.skills).toEqual(expect.arrayContaining(['Athletics', 'Perception']));
  });

  it('AC is 10 + DEX when no armor equipped (placeholder kit)', () => {
    const d = deriveCharacter(baseWizard);
    // The wizard hasn't actually placed armor yet — derive returns AC based on DEX only.
    // Equipment kit decision is recorded but resolved at character creation time.
    expect(d.ac).toBe(10 + 2);
  });
});
