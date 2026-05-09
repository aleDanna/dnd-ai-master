import { describe, it, expect } from 'vitest';
import { deriveCharacter } from '@/characters/derive';
import type { WizardState } from '@/characters/types';
import type { SrdFeat } from '@/db/schema';

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
  classChoices: { 'fighting-style': 'fighting-style-defense' },
  feats: [],
  identity: {
    name: 'Tharion', alignment: 'True Neutral',
    trait: '', bond: '', flaw: '', backstory: '',
    portraitColor: '#E0B84A',
  },
};

const alertFeat: SrdFeat = {
  slug: 'alert', name: 'Alert', prerequisites: 'None',
  benefits: '+5 to initiative; cannot be surprised while conscious; other creatures don\'t gain advantage on attacks against you from being unseen.',
  source: 'PHB',
};

const toughFeat: SrdFeat = {
  slug: 'tough', name: 'Tough', prerequisites: 'None',
  benefits: 'Hit point maximum increases by 2 × character level; +2 HP each subsequent level.',
  source: 'PHB',
};

describe('deriveCharacter — feats', () => {
  it('adds each picked feat to features[] with source "feat"', () => {
    const w: WizardState = { ...baseWizard, feats: ['alert', 'tough'] };
    const d = deriveCharacter(w, { feats: [alertFeat, toughFeat] });
    const featFeatures = d.features.filter((f) => f.source === 'feat');
    expect(featFeatures.map((f) => f.slug).sort()).toEqual(['alert', 'tough']);
  });

  it('feat description carries the SRD benefits text', () => {
    const w: WizardState = { ...baseWizard, feats: ['alert'] };
    const d = deriveCharacter(w, { feats: [alertFeat] });
    const alert = d.features.find((f) => f.slug === 'alert');
    expect(alert?.description).toMatch(/initiative/);
  });

  it('no feats → no feat features (empty list is fine)', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.features.filter((f) => f.source === 'feat')).toEqual([]);
  });

  it('silently ignores selected slugs not provided as rows (test mode safety)', () => {
    const w: WizardState = { ...baseWizard, feats: ['alert', 'doesnt-exist'] };
    // context.feats only has alertFeat — the other slug just isn't materialized.
    const d = deriveCharacter(w, { feats: [alertFeat] });
    expect(d.features.find((f) => f.slug === 'alert')).toBeDefined();
    expect(d.features.find((f) => f.slug === 'doesnt-exist')).toBeUndefined();
  });
});
