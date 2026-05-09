// Hand-curated starting equipment per class. The CSV "starting_equipment_summary"
// is free-form prose so we can't programmatically extract structured choices —
// the kits below normalize the PHB defaults into slug references so the wizard
// can present an explicit "A or B" UI and the chosen items end up in the
// PC's inventory at character creation. Slugs must match a row in srd_*
// (validated at module load by `validateAllKitSlugs`).

export interface KitItem {
  slug: string;
  qty: number;
}

export interface KitOption {
  /** Short label shown to the player (e.g. "Chain mail" or "Leather + longbow"). */
  label: string;
  items: KitItem[];
}

export interface KitChoice {
  /** Group label (e.g. "Armor", "Pack"). */
  label: string;
  options: KitOption[];
}

export interface StartingKit {
  /** Items always granted (no choice). */
  required: KitItem[];
  /** Player picks one option per choice. */
  choices: KitChoice[];
}

const PACK_DUNGEONEER_VS_EXPLORER: KitChoice = {
  label: 'Pack',
  options: [
    { label: "Dungeoneer's Pack", items: [{ slug: 'dungeoneers-pack', qty: 1 }] },
    { label: "Explorer's Pack", items: [{ slug: 'explorers-pack', qty: 1 }] },
  ],
};

const ARCANE_FOCUS_CHOICE: KitChoice = {
  label: 'Spellcasting focus',
  options: [
    { label: 'Component pouch', items: [{ slug: 'component-pouch', qty: 1 }] },
    { label: 'Crystal (arcane focus)', items: [{ slug: 'crystal-focus', qty: 1 }] },
    { label: 'Wand (arcane focus)', items: [{ slug: 'wand-focus', qty: 1 }] },
    { label: 'Staff (arcane focus)', items: [{ slug: 'staff-focus', qty: 1 }] },
  ],
};

const DRUIDIC_FOCUS_CHOICE: KitChoice = {
  label: 'Druidic focus',
  options: [
    { label: 'Sprig of Mistletoe', items: [{ slug: 'sprig-of-mistletoe', qty: 1 }] },
    { label: 'Totem', items: [{ slug: 'totem', qty: 1 }] },
    { label: 'Wooden Staff', items: [{ slug: 'wooden-staff', qty: 1 }] },
    { label: 'Yew Wand', items: [{ slug: 'yew-wand', qty: 1 }] },
  ],
};

export const STARTING_KITS: Record<string, StartingKit> = {
  barbarian: {
    required: [
      { slug: 'javelin', qty: 4 },
      { slug: 'explorers-pack', qty: 1 },
    ],
    choices: [
      {
        label: 'Primary weapon',
        options: [
          { label: 'Greataxe', items: [{ slug: 'greataxe', qty: 1 }] },
          { label: 'Battleaxe', items: [{ slug: 'battleaxe', qty: 1 }] },
          { label: 'Greatsword', items: [{ slug: 'greatsword', qty: 1 }] },
        ],
      },
      {
        label: 'Secondary weapons',
        options: [
          { label: 'Two handaxes', items: [{ slug: 'handaxe', qty: 2 }] },
          { label: 'Mace', items: [{ slug: 'mace', qty: 1 }] },
        ],
      },
    ],
  },

  bard: {
    required: [
      { slug: 'leather', qty: 1 },
      { slug: 'dagger', qty: 1 },
    ],
    choices: [
      {
        label: 'Primary weapon',
        options: [
          { label: 'Rapier', items: [{ slug: 'rapier', qty: 1 }] },
          { label: 'Longsword', items: [{ slug: 'longsword', qty: 1 }] },
          { label: 'Shortsword', items: [{ slug: 'shortsword', qty: 1 }] },
        ],
      },
      {
        label: 'Pack',
        options: [
          { label: "Diplomat's Pack", items: [{ slug: 'diplomats-pack', qty: 1 }] },
          { label: "Entertainer's Pack", items: [{ slug: 'entertainers-pack', qty: 1 }] },
        ],
      },
      {
        label: 'Musical instrument',
        options: [
          { label: 'Lute', items: [{ slug: 'lute', qty: 1 }] },
          { label: 'Flute', items: [{ slug: 'flute', qty: 1 }] },
          { label: 'Drum', items: [{ slug: 'drum', qty: 1 }] },
          { label: 'Bagpipes', items: [{ slug: 'bagpipes', qty: 1 }] },
        ],
      },
    ],
  },

  cleric: {
    required: [
      { slug: 'shield', qty: 1 },
      { slug: 'emblem-holy-symbol', qty: 1 },
      { slug: 'priests-pack', qty: 1 },
    ],
    choices: [
      {
        label: 'Primary weapon',
        options: [
          { label: 'Mace', items: [{ slug: 'mace', qty: 1 }] },
          { label: 'Warhammer (if proficient)', items: [{ slug: 'warhammer', qty: 1 }] },
        ],
      },
      {
        label: 'Armor',
        options: [
          { label: 'Scale mail', items: [{ slug: 'scale-mail', qty: 1 }] },
          { label: 'Leather armor', items: [{ slug: 'leather', qty: 1 }] },
          { label: 'Chain mail (if proficient)', items: [{ slug: 'chain-mail', qty: 1 }] },
        ],
      },
      {
        label: 'Ranged option',
        options: [
          { label: 'Light crossbow + 20 bolts', items: [{ slug: 'light-crossbow', qty: 1 }, { slug: 'crossbow-bolts-20', qty: 1 }] },
          { label: 'Mace (extra)', items: [{ slug: 'mace', qty: 1 }] },
        ],
      },
    ],
  },

  druid: {
    required: [
      { slug: 'leather', qty: 1 },
      { slug: 'explorers-pack', qty: 1 },
    ],
    choices: [
      {
        label: 'Shield or simple weapon',
        options: [
          { label: 'Wooden shield', items: [{ slug: 'shield', qty: 1 }] },
          { label: 'Mace', items: [{ slug: 'mace', qty: 1 }] },
        ],
      },
      {
        label: 'Melee weapon',
        options: [
          { label: 'Scimitar', items: [{ slug: 'scimitar', qty: 1 }] },
          { label: 'Sickle', items: [{ slug: 'sickle', qty: 1 }] },
          { label: 'Quarterstaff', items: [{ slug: 'quarterstaff', qty: 1 }] },
        ],
      },
      DRUIDIC_FOCUS_CHOICE,
    ],
  },

  fighter: {
    required: [],
    choices: [
      {
        label: 'Armor',
        options: [
          { label: 'Chain mail', items: [{ slug: 'chain-mail', qty: 1 }] },
          { label: 'Leather + longbow + 20 arrows',
            items: [{ slug: 'leather', qty: 1 }, { slug: 'longbow', qty: 1 }, { slug: 'arrows-20', qty: 1 }] },
        ],
      },
      {
        label: 'Primary',
        options: [
          { label: 'Martial weapon (longsword) + shield',
            items: [{ slug: 'longsword', qty: 1 }, { slug: 'shield', qty: 1 }] },
          { label: 'Two martial weapons (longsword + shortsword)',
            items: [{ slug: 'longsword', qty: 1 }, { slug: 'shortsword', qty: 1 }] },
        ],
      },
      {
        label: 'Ranged',
        options: [
          { label: 'Light crossbow + 20 bolts',
            items: [{ slug: 'light-crossbow', qty: 1 }, { slug: 'crossbow-bolts-20', qty: 1 }] },
          { label: 'Two handaxes', items: [{ slug: 'handaxe', qty: 2 }] },
        ],
      },
      PACK_DUNGEONEER_VS_EXPLORER,
    ],
  },

  monk: {
    required: [
      { slug: 'dart', qty: 10 },
    ],
    choices: [
      {
        label: 'Primary weapon',
        options: [
          { label: 'Shortsword', items: [{ slug: 'shortsword', qty: 1 }] },
          { label: 'Quarterstaff', items: [{ slug: 'quarterstaff', qty: 1 }] },
        ],
      },
      PACK_DUNGEONEER_VS_EXPLORER,
    ],
  },

  paladin: {
    required: [
      { slug: 'chain-mail', qty: 1 },
      { slug: 'emblem-holy-symbol', qty: 1 },
    ],
    choices: [
      {
        label: 'Primary',
        options: [
          { label: 'Martial weapon (longsword) + shield',
            items: [{ slug: 'longsword', qty: 1 }, { slug: 'shield', qty: 1 }] },
          { label: 'Two martial weapons (longsword + shortsword)',
            items: [{ slug: 'longsword', qty: 1 }, { slug: 'shortsword', qty: 1 }] },
        ],
      },
      {
        label: 'Secondary',
        options: [
          { label: '5 javelins', items: [{ slug: 'javelin', qty: 5 }] },
          { label: 'Mace', items: [{ slug: 'mace', qty: 1 }] },
        ],
      },
      {
        label: 'Pack',
        options: [
          { label: "Priest's Pack", items: [{ slug: 'priests-pack', qty: 1 }] },
          { label: "Explorer's Pack", items: [{ slug: 'explorers-pack', qty: 1 }] },
        ],
      },
    ],
  },

  ranger: {
    required: [
      { slug: 'longbow', qty: 1 },
      { slug: 'arrows-20', qty: 1 },
    ],
    choices: [
      {
        label: 'Armor',
        options: [
          { label: 'Scale mail', items: [{ slug: 'scale-mail', qty: 1 }] },
          { label: 'Leather armor', items: [{ slug: 'leather', qty: 1 }] },
        ],
      },
      {
        label: 'Melee weapons',
        options: [
          { label: 'Two shortswords', items: [{ slug: 'shortsword', qty: 2 }] },
          { label: 'Two scimitars', items: [{ slug: 'scimitar', qty: 2 }] },
        ],
      },
      PACK_DUNGEONEER_VS_EXPLORER,
    ],
  },

  rogue: {
    required: [
      { slug: 'leather', qty: 1 },
      { slug: 'dagger', qty: 2 },
      { slug: 'thieves-tools', qty: 1 },
    ],
    choices: [
      {
        label: 'Primary weapon',
        options: [
          { label: 'Rapier', items: [{ slug: 'rapier', qty: 1 }] },
          { label: 'Shortsword', items: [{ slug: 'shortsword', qty: 1 }] },
        ],
      },
      {
        label: 'Ranged or shortsword',
        options: [
          { label: 'Shortbow + 20 arrows',
            items: [{ slug: 'shortbow', qty: 1 }, { slug: 'arrows-20', qty: 1 }] },
          { label: 'Shortsword', items: [{ slug: 'shortsword', qty: 1 }] },
        ],
      },
      {
        label: 'Pack',
        options: [
          { label: "Burglar's Pack", items: [{ slug: 'burglars-pack', qty: 1 }] },
          { label: "Dungeoneer's Pack", items: [{ slug: 'dungeoneers-pack', qty: 1 }] },
          { label: "Explorer's Pack", items: [{ slug: 'explorers-pack', qty: 1 }] },
        ],
      },
    ],
  },

  sorcerer: {
    required: [
      { slug: 'dagger', qty: 2 },
    ],
    choices: [
      {
        label: 'Ranged',
        options: [
          { label: 'Light crossbow + 20 bolts',
            items: [{ slug: 'light-crossbow', qty: 1 }, { slug: 'crossbow-bolts-20', qty: 1 }] },
          { label: 'Mace', items: [{ slug: 'mace', qty: 1 }] },
        ],
      },
      ARCANE_FOCUS_CHOICE,
      PACK_DUNGEONEER_VS_EXPLORER,
    ],
  },

  warlock: {
    required: [
      { slug: 'leather', qty: 1 },
      { slug: 'dagger', qty: 2 },
    ],
    choices: [
      {
        label: 'Ranged',
        options: [
          { label: 'Light crossbow + 20 bolts',
            items: [{ slug: 'light-crossbow', qty: 1 }, { slug: 'crossbow-bolts-20', qty: 1 }] },
          { label: 'Mace', items: [{ slug: 'mace', qty: 1 }] },
        ],
      },
      ARCANE_FOCUS_CHOICE,
      {
        label: 'Pack',
        options: [
          { label: "Scholar's Pack", items: [{ slug: 'scholars-pack', qty: 1 }] },
          { label: "Dungeoneer's Pack", items: [{ slug: 'dungeoneers-pack', qty: 1 }] },
        ],
      },
    ],
  },

  wizard: {
    required: [
      { slug: 'spellbook', qty: 1 },
    ],
    choices: [
      {
        label: 'Weapon',
        options: [
          { label: 'Quarterstaff', items: [{ slug: 'quarterstaff', qty: 1 }] },
          { label: 'Dagger', items: [{ slug: 'dagger', qty: 1 }] },
        ],
      },
      ARCANE_FOCUS_CHOICE,
      {
        label: 'Pack',
        options: [
          { label: "Scholar's Pack", items: [{ slug: 'scholars-pack', qty: 1 }] },
          { label: "Explorer's Pack", items: [{ slug: 'explorers-pack', qty: 1 }] },
        ],
      },
    ],
  },
};

export function getStartingKit(classSlug: string | null): StartingKit | null {
  if (!classSlug) return null;
  return STARTING_KITS[classSlug] ?? null;
}

/**
 * Resolve player choices into a flat item list. `picks[i]` is the option index
 * for choice i. Missing/out-of-range picks default to option 0. Items stack
 * naturally if the same slug appears in `required` and a chosen option.
 */
export function resolveKitItems(kit: StartingKit, picks: number[]): KitItem[] {
  const merged = new Map<string, number>();
  const add = (it: KitItem): void => {
    merged.set(it.slug, (merged.get(it.slug) ?? 0) + it.qty);
  };
  for (const it of kit.required) add(it);
  for (let i = 0; i < kit.choices.length; i++) {
    const choice = kit.choices[i]!;
    const idx = picks[i];
    const safeIdx = typeof idx === 'number' && idx >= 0 && idx < choice.options.length ? idx : 0;
    for (const it of choice.options[safeIdx]!.items) add(it);
  }
  return Array.from(merged.entries()).map(([slug, qty]) => ({ slug, qty }));
}
