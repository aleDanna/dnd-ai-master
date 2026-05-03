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

/** Composes the final OpenAI image prompt with the chosen style and a fixed safety suffix. */
export function buildImagePrompt(visualPrompt: string, styleText: string): string {
  const trimmed = visualPrompt.trim().replace(/\.+$/, '');
  return `${trimmed}. Art style: ${styleText}. No text, no watermarks.`;
}
