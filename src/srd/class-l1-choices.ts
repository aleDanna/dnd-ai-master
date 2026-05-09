// Hand-curated level-1 class choices. The CSV's `key_class_features` column
// lists choice POINTS (e.g. "Fighting Style") but not the OPTIONS — the
// PHB's prose enumerates them. This module spells out the options as
// structured data so the wizard can render a tile-picker, validation can
// enforce a pick, and derivation can attach the chosen option as a feature.
//
// Coverage: Fighter (Fighting Style), Cleric (Divine Domain), Sorcerer
// (Sorcerous Origin), Warlock (Otherworldly Patron). Rogue Expertise,
// Ranger Favored Enemy / Natural Explorer, and caster cantrip/spell
// selection are intentionally NOT here — they need dynamic option lists or
// multi-select UIs that warrant their own phase.

export interface ChoiceOption {
  /** Unique slug across ALL options for this class (used as feature slug). */
  slug: string;
  /** Display name shown in tiles. */
  name: string;
  /** Long-form description (becomes the `features[].description`). */
  description: string;
}

export interface ClassChoice {
  /** Stable key — used in WizardState.classChoices. */
  key: string;
  label: string;
  helperText?: string;
  options: ChoiceOption[];
}

export const CLASS_L1_CHOICES: Record<string, ClassChoice[]> = {
  fighter: [
    {
      key: 'fighting-style',
      label: 'Fighting Style',
      helperText: 'Choose a combat specialization. The bonus is permanent and stacks with other features.',
      options: [
        { slug: 'fighting-style-archery', name: 'Archery', description: '+2 to attack rolls with ranged weapons.' },
        { slug: 'fighting-style-defense', name: 'Defense', description: '+1 AC while wearing armor.' },
        { slug: 'fighting-style-dueling', name: 'Dueling', description: '+2 damage with a one-handed melee weapon when no other weapon is held.' },
        { slug: 'fighting-style-great-weapon-fighting', name: 'Great Weapon Fighting', description: 'Reroll 1s and 2s on damage with two-handed melee weapons (must take new roll).' },
        { slug: 'fighting-style-protection', name: 'Protection', description: 'Use reaction with a shield to impose disadvantage on an attack against a creature within 5 ft.' },
        { slug: 'fighting-style-two-weapon-fighting', name: 'Two-Weapon Fighting', description: 'Add ability modifier to off-hand attack damage.' },
      ],
    },
  ],

  cleric: [
    {
      key: 'divine-domain',
      label: 'Divine Domain',
      helperText: 'Pick the aspect of your deity you embody. Each domain grants bonus spells and a level-1 ability.',
      options: [
        { slug: 'domain-life', name: 'Life Domain', description: 'Heavy armor proficiency; bonus healing-magic features (cure wounds, healing word, …); Disciple of Life: +2 + spell level when restoring HP.' },
        { slug: 'domain-light', name: 'Light Domain', description: 'Bonus cantrip Light; Warding Flame reaction; bonus spells (faerie fire, burning hands, scorching ray, …).' },
        { slug: 'domain-war', name: 'War Domain', description: 'Heavy armor + martial weapon proficiency; War Priest (bonus action attack PB times/long rest); bonus spells (divine favor, shield of faith, …).' },
        { slug: 'domain-knowledge', name: 'Knowledge Domain', description: 'Two extra languages; choose 2 of Arcana/History/Nature/Religion (Expertise); bonus spells (command, identify, …).' },
        { slug: 'domain-trickery', name: 'Trickery Domain', description: 'Blessing of the Trickster (advantage on Stealth) once on touch; bonus spells (charm person, disguise self, …).' },
      ],
    },
  ],

  sorcerer: [
    {
      key: 'sorcerous-origin',
      label: 'Sorcerous Origin',
      helperText: 'The source of your innate magic.',
      options: [
        { slug: 'origin-draconic-bloodline', name: 'Draconic Bloodline', description: 'Dragon Ancestor (one of ten chromatic/metallic types); +1 HP per sorcerer level; Draconic Resilience (AC 13 + DEX when unarmored).' },
        { slug: 'origin-wild-magic', name: 'Wild Magic', description: 'Wild Magic Surge (1-in-20 chance per leveled spell to roll on the Surge table); Tides of Chaos (advantage on one roll per long rest, may trigger a Surge).' },
      ],
    },
  ],

  warlock: [
    {
      key: 'otherworldly-patron',
      label: 'Otherworldly Patron',
      helperText: 'The entity that grants you power. Patron determines bonus spells and one expanded feature.',
      options: [
        { slug: 'patron-archfey', name: 'The Archfey', description: 'Fey Presence: 10-ft cube WIS save or charmed/frightened until end of next turn (PB times/short rest).' },
        { slug: 'patron-fiend', name: 'The Fiend', description: 'Dark One\'s Blessing: temp HP equal to CHA mod + warlock level on reducing a hostile to 0 HP.' },
        { slug: 'patron-great-old-one', name: 'The Great Old One', description: 'Awakened Mind: telepathic communication out to 30 ft with creatures that share at least one language.' },
      ],
    },
  ],
};

export function getClassChoices(classSlug: string | null): ClassChoice[] {
  if (!classSlug) return [];
  return CLASS_L1_CHOICES[classSlug] ?? [];
}

/** Find the option object for a given class+key+slug. */
export function findClassChoiceOption(
  classSlug: string,
  key: string,
  optionSlug: string,
): ChoiceOption | null {
  const choices = CLASS_L1_CHOICES[classSlug];
  if (!choices) return null;
  const choice = choices.find((c) => c.key === key);
  if (!choice) return null;
  return choice.options.find((o) => o.slug === optionSlug) ?? null;
}
