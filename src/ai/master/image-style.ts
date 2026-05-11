import type { UserPreferences } from '@/db/schema/users';

const PRESETS: Record<Exclude<NonNullable<UserPreferences['imageStylePreset']>, 'custom'>, string> = {
  pastel:    'soft colored pastel drawing, hand-drawn texture, gentle lighting',
  watercolor:'loose watercolor painting, wet edges, muted palette',
  oil:       'oil painting on canvas, painterly brushstrokes, classical lighting',
  ink:       'black ink illustration, hatched shadows, fantasy book engraving',
  photo:     'cinematic photograph, dramatic lighting, shallow depth of field',
};

/** Resolves the user-facing style preset (or custom override) to the English style string we feed to the image model. */
export function resolveStyleText(prefs: UserPreferences): string {
  if (prefs.imageStylePreset === 'custom') {
    const trimmed = (prefs.imageStyleCustom ?? '').trim();
    if (trimmed) return trimmed;
    return PRESETS.pastel;
  }
  const preset = prefs.imageStylePreset ?? 'pastel';
  return PRESETS[preset];
}

export interface CharacterAppearance {
  name: string;
  raceSlug: string;
  classSlug: string;
  identity: {
    alignment: string;
    trait?: string;
    bond?: string;
    flaw?: string;
    backstory?: string;
    portraitColor?: string;
  };
}

/** Map class/race slugs back to readable English names for the image prompt. */
function humanize(slug: string): string {
  return slug.replace(/-/g, ' ');
}

const APPEARANCE_HINT_LIMIT = 220;

/** Produce a concise English description of the protagonist for the image model.
 *  Pulls from race/class/identity (trait + backstory) so generated illustrations
 *  feature the actual PC instead of a generic adventurer. Kept short to avoid
 *  drowning the scene narration in character backstory. */
export function buildCharacterAppearance(c: CharacterAppearance | null | undefined): string {
  if (!c) return '';
  const race = humanize(c.raceSlug);
  const klass = humanize(c.classSlug);
  const align = c.identity.alignment.toLowerCase();
  const parts: string[] = [`Protagonist: ${c.name}, a ${align} ${race} ${klass}.`];

  // trait is a "personality trait" line from the PHB background, often
  // including physical mannerisms — useful for image guidance.
  const trait = c.identity.trait?.trim();
  if (trait) parts.push(`Trait: ${trait.slice(0, APPEARANCE_HINT_LIMIT)}.`);

  // Backstory frequently contains physical/clothing/equipment hints.
  const backstory = c.identity.backstory?.trim();
  if (backstory) {
    parts.push(`Background: ${backstory.slice(0, APPEARANCE_HINT_LIMIT)}.`);
  }

  return parts.join(' ');
}

/** Composes the final image prompt with the chosen style and a fixed safety suffix.
 *  When characterAppearance is provided, the image model is instructed to feature
 *  the specific PC (race, class, identity hints) so the generated scene shows the
 *  actual protagonist rather than a generic adventurer. */
export function buildImagePrompt(
  visualPrompt: string,
  styleText: string,
  characterAppearance?: string,
): string {
  const scene = visualPrompt.trim().replace(/\.+$/, '');
  const subject = characterAppearance?.trim();
  const subjectClause = subject
    ? ` Feature the protagonist consistently across renderings: ${subject}.`
    : '';
  return `${scene}.${subjectClause} Art style: ${styleText}. No text, no watermarks.`;
}
