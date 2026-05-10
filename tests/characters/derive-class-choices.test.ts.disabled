import { describe, it, expect } from 'vitest';
import { deriveCharacter } from '@/characters/derive';
import type { WizardState } from '@/characters/types';

const baseWizard: WizardState = {
  raceSlug: 'human',
  subraceSlug: null,
  classSlug: 'fighter',
  backgroundSlug: 'soldier',
  abilityMethod: 'array',
  abilities: { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 },
  skills: ['Athletics'],
  equipmentChoice: 'kit',
  kitChoices: [],
  classChoices: {},
  feats: [],
  identity: {
    name: 'Tharion', alignment: 'True Neutral',
    trait: '', bond: '', flaw: '', backstory: '',
    portraitColor: '#E0B84A',
  },
};

describe('class L1 choices → features', () => {
  it('Fighter Defense fighting style is added to features', () => {
    const w: WizardState = { ...baseWizard, classChoices: { 'fighting-style': 'fighting-style-defense' } };
    const d = deriveCharacter(w);
    const feature = d.features.find((f) => f.slug === 'fighting-style-defense');
    expect(feature).toBeDefined();
    expect(feature?.source).toBe('class');
    expect(feature?.description).toMatch(/AC/);
  });

  it('skips choice features when nothing is picked', () => {
    const d = deriveCharacter(baseWizard);
    const slug = d.features.find((f) => f.slug.startsWith('fighting-style-'));
    expect(slug).toBeUndefined();
  });

  it('rejects unknown option slug silently (does not add a fake feature)', () => {
    const w: WizardState = { ...baseWizard, classChoices: { 'fighting-style': 'fighting-style-bogus' } };
    const d = deriveCharacter(w);
    expect(d.features.find((f) => f.slug === 'fighting-style-bogus')).toBeUndefined();
  });

  it('Cleric Life Domain is added', () => {
    const w: WizardState = {
      ...baseWizard, classSlug: 'cleric',
      classChoices: { 'divine-domain': 'domain-life' },
    };
    const d = deriveCharacter(w);
    const f = d.features.find((ff) => ff.slug === 'domain-life');
    expect(f).toBeDefined();
    expect(f?.description).toMatch(/Disciple of Life|healing/i);
  });
});

describe('class choice validation (via derive does not enforce — that\'s validate.ts)', () => {
  it('derive still produces a valid character if class choice missing (validation is separate)', () => {
    const d = deriveCharacter({ ...baseWizard, classChoices: {} });
    expect(d.classSlug).toBe('fighter');
    expect(d.hpMax).toBeGreaterThan(0);
  });
});
