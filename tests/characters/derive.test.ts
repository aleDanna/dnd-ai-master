import { describe, it, expect } from 'vitest';
import { deriveCharacter } from '@/characters/derive';
import type { WizardState } from '@/characters/types';
import type { SrdBackground } from '@/db/schema';

const baseWizard: WizardState = {
  raceSlug: 'half-elf',
  subraceSlug: null,
  classSlug: 'fighter',
  backgroundSlug: 'soldier',
  abilityMethod: 'array',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  skills: ['Athletics', 'Perception'],
  equipmentChoice: 'kit',
  kitChoices: [],
  classChoices: {},
  feats: [],
  identity: {
    name: 'Tharion',
    alignment: 'True Neutral',
    trait: '', bond: '', flaw: '', backstory: '',
    portraitColor: '#E0B84A',
  },
};

const soldierBg: SrdBackground = {
  slug: 'soldier',
  name: 'Soldier',
  skillProficiencies: ['Athletics', 'Intimidation'],
  toolProficiencies: [],
  languages: '',
  startingEquipment: '',
  feature: '',
  suggestedTraits: null,
  source: 'PHB',
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

describe('deriveCharacter spellcasting', () => {
  it('returns null spellcasting for non-caster classes', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.spellcasting).toBeNull();
  });

  it('populates spellcasting with starter spells for a wizard', () => {
    const w: WizardState = { ...baseWizard, classSlug: 'wizard', abilities: { STR: 8, DEX: 14, CON: 14, INT: 16, WIS: 12, CHA: 10 } };
    const d = deriveCharacter(w);
    expect(d.spellcasting).not.toBeNull();
    expect(d.spellcasting!.ability).toBe('INT');
    // L1 PB 2 + INT mod 3 = save DC 13, attack +5
    expect(d.spellcasting!.spellSaveDC).toBe(13);
    expect(d.spellcasting!.spellAttackBonus).toBe(5);
    expect(d.spellcasting!.slotsMax[1]).toBe(2);
    expect(d.spellcasting!.spellsKnown).toContain('magic-missile');
    expect(d.spellcasting!.spellsKnown).toContain('fire-bolt');
    expect(d.spellcasting!.spellsPrepared.length).toBeGreaterThan(0);
  });

  it('populates spellcasting for warlock with 1 L1 slot', () => {
    const w: WizardState = { ...baseWizard, classSlug: 'warlock' };
    const d = deriveCharacter(w);
    expect(d.spellcasting).not.toBeNull();
    expect(d.spellcasting!.ability).toBe('CHA');
    expect(d.spellcasting!.slotsMax[1]).toBe(1);
    expect(d.spellcasting!.spellsKnown).toContain('eldritch-blast');
  });

  it('paladin gets a spellcasting block but no L1 slots', () => {
    const w: WizardState = { ...baseWizard, classSlug: 'paladin' };
    const d = deriveCharacter(w);
    expect(d.spellcasting).not.toBeNull();
    expect(d.spellcasting!.ability).toBe('CHA');
    expect(d.spellcasting!.slotsMax[1] ?? 0).toBe(0);
    expect(d.spellcasting!.spellsKnown).toEqual([]);
  });
});

describe('deriveCharacter with background context', () => {
  it('merges background skill proficiencies into proficiencies.skills', () => {
    const w: WizardState = { ...baseWizard, skills: ['Perception'] };
    const d = deriveCharacter(w, { background: soldierBg });
    expect(d.proficiencies.skills).toEqual(expect.arrayContaining(['Perception', 'Athletics', 'Intimidation']));
  });

  it('does not duplicate when wizard and background overlap', () => {
    const w: WizardState = { ...baseWizard, skills: ['Athletics'] };
    const d = deriveCharacter(w, { background: soldierBg });
    const athleticsCount = d.proficiencies.skills.filter((s) => s === 'Athletics').length;
    expect(athleticsCount).toBe(1);
  });

  it('still works without context (background optional)', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.proficiencies.skills).toEqual(['Athletics', 'Perception']);
  });
});
