import { describe, it, expect } from 'vitest';
import { deriveCharacter } from '@/characters/derive';
import type { WizardState } from '@/characters/types';
import type { SrdBackground, SrdClass, SrdRace } from '@/db/schema';

const baseWizard: WizardState = {
  raceSlug: 'dwarf',
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

const dwarfRace: SrdRace = {
  slug: 'dwarf', name: 'Dwarf', parentRaceSlug: null,
  abilityScoreIncrease: { CON: 2 },
  size: 'Medium', speed: 25,
  ageNote: '~350 years',
  languages: ['Common', 'Dwarvish'],
  traits: [
    { name: 'Darkvision 60ft', description: '' },
    { name: 'Dwarven Resilience', description: 'advantage vs poison saves, resistance vs poison damage' },
  ],
  subraceOptions: ['Hill Dwarf', 'Mountain Dwarf'],
  source: 'PHB',
};

const hillDwarf: SrdRace = {
  ...dwarfRace,
  slug: 'hill-dwarf', name: 'Hill Dwarf', parentRaceSlug: 'dwarf',
  abilityScoreIncrease: { WIS: 1 },
  traits: [{ name: 'Dwarven Toughness', description: 'HP max +1 per level' }],
  subraceOptions: [],
};

const fighterClass: SrdClass = {
  slug: 'fighter', name: 'Fighter', hitDie: 'd10',
  primaryAbility: ['Strength'],
  savingThrows: ['STR', 'CON'],
  proficiencies: {
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    weapons: ['Simple', 'Martial'],
    tools: ['None'],
    skillsChoose: 2,
    skillsFrom: ['Acrobatics', 'Athletics', 'History', 'Insight', 'Intimidation', 'Perception', 'Survival'],
  },
  spellcasting: null,
  subclassName: 'Martial Archetype',
  subclassChoiceLevel: 3,
  subclasses: [],
  keyFeatures: [
    { level: 1, features: ['Fighting Style', 'Second Wind'] },
    { level: 2, features: ['Action Surge'] },
  ],
  startingEquipmentSummary: 'chain mail OR leather armor + longbow + 20 arrows; martial weapon and shield OR two martial weapons; light crossbow and 20 bolts OR 2 handaxes; dungeoneer\'s pack OR explorer\'s pack',
  source: 'PHB',
};

const soldierBg: SrdBackground = {
  slug: 'soldier', name: 'Soldier',
  skillProficiencies: ['Athletics', 'Intimidation'],
  toolProficiencies: ['Gaming Set', 'Vehicles (Land)'],
  languages: 'None',
  startingEquipment: '',
  feature: 'Military Rank: receive deference from soldiers of similar rank.',
  suggestedTraits: null,
  source: 'PHB',
};

const acolyteBg: SrdBackground = {
  ...soldierBg,
  slug: 'acolyte', name: 'Acolyte',
  skillProficiencies: ['Insight', 'Religion'],
  toolProficiencies: ['None'],
  languages: 'Two of choice',
  feature: 'Shelter of the Faithful: receive free care at temples.',
};

describe('deriveCharacter — racial derivation', () => {
  it('applies racial ASI to wizard abilities (Dwarf +2 CON)', () => {
    const d = deriveCharacter(baseWizard, { race: dwarfRace, klass: fighterClass, background: soldierBg });
    expect(d.abilities.CON).toBe(13 + 2);
    // HP recomputes from new CON: 10 + (15-10)/2 floor = 10 + 2 = 12
    expect(d.hpMax).toBe(10 + 2);
  });

  it('combines parent race ASI with subrace ASI (Hill Dwarf = +2 CON +1 WIS)', () => {
    const w: WizardState = { ...baseWizard, raceSlug: 'hill-dwarf' };
    const d = deriveCharacter(w, { race: hillDwarf, parentRace: dwarfRace, klass: fighterClass, background: soldierBg });
    expect(d.abilities.CON).toBe(13 + 2);
    expect(d.abilities.WIS).toBe(10 + 1);
  });

  it('uses race speed (Dwarf 25)', () => {
    const d = deriveCharacter(baseWizard, { race: dwarfRace, klass: fighterClass, background: soldierBg });
    expect(d.speed).toBe(25);
  });

  it('subrace speed overrides parent (when supplied)', () => {
    const woodElf: SrdRace = {
      slug: 'wood-elf', name: 'Wood Elf', parentRaceSlug: 'elf',
      abilityScoreIncrease: { WIS: 1 }, size: 'Medium', speed: 35, ageNote: null,
      languages: ['Common', 'Elvish'], traits: [], subraceOptions: [], source: 'PHB',
    };
    const elf: SrdRace = {
      slug: 'elf', name: 'Elf', parentRaceSlug: null,
      abilityScoreIncrease: { DEX: 2 }, size: 'Medium', speed: 30, ageNote: null,
      languages: ['Common', 'Elvish'], traits: [], subraceOptions: [], source: 'PHB',
    };
    const w: WizardState = { ...baseWizard, raceSlug: 'wood-elf' };
    const d = deriveCharacter(w, { race: woodElf, parentRace: elf, klass: fighterClass, background: soldierBg });
    expect(d.speed).toBe(35);
  });

  it('merges racial languages into proficiencies.languages with Common always present', () => {
    const d = deriveCharacter(baseWizard, { race: dwarfRace, klass: fighterClass, background: soldierBg });
    expect(d.proficiencies.languages).toEqual(expect.arrayContaining(['Common', 'Dwarvish']));
  });

  it('adds racial traits to features[]', () => {
    const d = deriveCharacter(baseWizard, { race: dwarfRace, klass: fighterClass, background: soldierBg });
    const slugs = d.features.map((f) => f.slug);
    expect(slugs).toContain('darkvision-60ft');
    expect(slugs).toContain('dwarven-resilience');
    const feature = d.features.find((f) => f.slug === 'dwarven-resilience');
    expect(feature?.source).toBe('race');
    expect(feature?.description).toMatch(/poison/i);
  });

  it('falls back to wizard abilities if no race row provided (legacy callers)', () => {
    const d = deriveCharacter(baseWizard);
    expect(d.abilities).toEqual(baseWizard.abilities);
    expect(d.speed).toBe(30);  // default
  });
});

describe('deriveCharacter — class derivation', () => {
  it('applies class proficiencies (armor + weapons)', () => {
    const d = deriveCharacter(baseWizard, { klass: fighterClass });
    expect(d.proficiencies.armor).toEqual(['Light', 'Medium', 'Heavy', 'Shield']);
    expect(d.proficiencies.weapons).toEqual(['Simple', 'Martial']);
  });

  it('strips "None" from class tools', () => {
    const d = deriveCharacter(baseWizard, { klass: fighterClass });
    expect(d.proficiencies.tools).not.toContain('None');
  });

  it('adds level-1 class features to features[]', () => {
    const d = deriveCharacter(baseWizard, { klass: fighterClass });
    const slugs = d.features.map((f) => f.slug);
    expect(slugs).toContain('fighting-style');
    expect(slugs).toContain('second-wind');
    const fighting = d.features.find((f) => f.slug === 'fighting-style');
    expect(fighting?.source).toBe('class');
  });

  it('does NOT add level-2+ features at L1', () => {
    const d = deriveCharacter(baseWizard, { klass: fighterClass });
    const slugs = d.features.map((f) => f.slug);
    expect(slugs).not.toContain('action-surge');
  });
});

describe('deriveCharacter — background derivation', () => {
  it('applies background tool proficiencies', () => {
    const d = deriveCharacter(baseWizard, { background: soldierBg });
    expect(d.proficiencies.tools).toEqual(expect.arrayContaining(['Gaming Set', 'Vehicles (Land)']));
  });

  it('adds background feature to features[]', () => {
    const d = deriveCharacter(baseWizard, { background: soldierBg });
    const feature = d.features.find((f) => f.slug === 'military-rank');
    expect(feature).toBeDefined();
    expect(feature?.source).toBe('background');
    expect(feature?.description).toMatch(/Military Rank/i);
  });

  it('marks pending language choices for backgrounds with "Two of choice"', () => {
    const w: WizardState = { ...baseWizard, backgroundSlug: 'acolyte' };
    const d = deriveCharacter(w, { background: acolyteBg });
    const pending = d.features.find((f) => f.slug === 'background-language-choice-pending');
    expect(pending).toBeDefined();
    expect(pending?.description).toMatch(/2/);
  });

  it('does not emit pending feature when background languages are "None"', () => {
    const d = deriveCharacter(baseWizard, { background: soldierBg });
    expect(d.features.find((f) => f.slug === 'background-language-choice-pending')).toBeUndefined();
  });
});

describe('deriveCharacter — combined', () => {
  it('full derivation: dwarf-fighter-soldier produces consistent character', () => {
    const d = deriveCharacter(baseWizard, { race: dwarfRace, klass: fighterClass, background: soldierBg });
    expect(d.abilities.CON).toBe(15);                                     // 13 + 2
    expect(d.proficiencies.weapons).toContain('Martial');
    expect(d.proficiencies.languages).toEqual(expect.arrayContaining(['Common', 'Dwarvish']));
    expect(d.proficiencies.tools).toEqual(expect.arrayContaining(['Gaming Set']));
    const slugs = d.features.map((f) => f.slug);
    expect(slugs).toEqual(expect.arrayContaining(['darkvision-60ft', 'fighting-style', 'second-wind', 'military-rank']));
  });
});
