import type { Ability, Skill } from '@/engine/types';

export interface WizardAbilities {
  STR: number;
  DEX: number;
  CON: number;
  INT: number;
  WIS: number;
  CHA: number;
}

export type AbilityMethod = 'array' | 'pointbuy' | 'roll';

export interface WizardState {
  /** Base race slug (e.g. "dwarf", "elf", "human"). Always set before progressing past the race step. */
  raceSlug: string | null;
  /**
   * Subrace slug (e.g. "hill-dwarf"), required when the base race has child rows
   * in `srd_race` (`parent_race_slug = raceSlug`). For races without subraces
   * (half-elf, half-orc, tiefling) this stays null.
   */
  subraceSlug: string | null;
  classSlug: string | null;
  backgroundSlug: string | null;
  abilityMethod: AbilityMethod;
  abilities: WizardAbilities;
  skills: Skill[];
  equipmentChoice: 'kit' | 'gold';
  /**
   * One option index per kit choice (in `STARTING_KITS[classSlug].choices`
   * order). Empty / shorter array means defaults; the resolver clamps
   * out-of-range indices to 0.
   */
  kitChoices: number[];
  /**
   * Level-1 class choices, keyed by `ClassChoice.key` (e.g. fighting-style,
   * divine-domain). Value is the chosen option slug from
   * `CLASS_L1_CHOICES[classSlug]`. Cleared when the class changes.
   */
  classChoices: Record<string, string>;
  /**
   * Selected feat slugs (resolve to rows in srd_feat). At level 1 most PCs
   * pick zero — exception: the Variant Human grants 1. Validation enforces
   * the cap based on race/class flags; an empty array is always valid.
   */
  feats: string[];
  identity: {
    name: string;
    alignment: string;
    trait: string;
    bond: string;
    flaw: string;
    backstory: string;
    portraitColor: string;
  };
}

export const STANDARD_ARRAY: number[] = [15, 14, 13, 12, 10, 8];

/** D&D 5e point-buy budget. Min/max are pre-racial-bonus. */
export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_MIN = 8;
export const POINT_BUY_MAX = 15;
/** Cost in points for each score from 8 to 15. Per the D&D 5e PHB. */
export const POINT_BUY_COST: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

export const ABILITIES: Ability[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

export const ALIGNMENTS: string[] = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
];

export const PORTRAIT_COLORS: string[] = [
  '#E0B84A', '#9C73D6', '#F0533A', '#2D8F6F', '#E68A2C', '#7A4FB8', '#B5A48A', '#D7331C',
];

export function emptyWizardState(): WizardState {
  return {
    raceSlug: null,
    subraceSlug: null,
    classSlug: null,
    backgroundSlug: null,
    abilityMethod: 'array',
    abilities: { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 },
    skills: [],
    equipmentChoice: 'kit',
    kitChoices: [],
    classChoices: {},
    feats: [],
    identity: {
      name: '',
      alignment: 'True Neutral',
      trait: '',
      bond: '',
      flaw: '',
      backstory: '',
      portraitColor: '#E0B84A',
    },
  };
}
