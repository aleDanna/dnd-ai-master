import { describe, it, expect } from 'vitest';
import { resolveStyleText, buildImagePrompt, buildCharacterAppearance } from '@/ai/master/image-style';
import type { UserPreferences } from '@/db/schema/users';

describe('resolveStyleText', () => {
  it('returns the pastel preset by default', () => {
    expect(resolveStyleText({})).toContain('pastel');
  });

  it('returns the right preset for each non-custom slug', () => {
    expect(resolveStyleText({ imageStylePreset: 'pastel' })).toContain('pastel');
    expect(resolveStyleText({ imageStylePreset: 'watercolor' })).toContain('watercolor');
    expect(resolveStyleText({ imageStylePreset: 'oil' })).toContain('oil');
    expect(resolveStyleText({ imageStylePreset: 'ink' })).toContain('ink');
    expect(resolveStyleText({ imageStylePreset: 'photo' })).toContain('photograph');
  });

  it('returns the user-supplied custom string when preset is custom', () => {
    const prefs: UserPreferences = { imageStylePreset: 'custom', imageStyleCustom: '  retro pixel art  ' };
    expect(resolveStyleText(prefs)).toBe('retro pixel art');
  });

  it('falls back to pastel when preset is custom but custom string is empty', () => {
    const prefs: UserPreferences = { imageStylePreset: 'custom', imageStyleCustom: '   ' };
    expect(resolveStyleText(prefs)).toContain('pastel');
  });
});

describe('buildImagePrompt', () => {
  it('combines the visual prompt and style text with a fixed safety suffix', () => {
    const out = buildImagePrompt('A goblin in a cave', 'soft pastel drawing');
    expect(out).toBe('A goblin in a cave. Art style: soft pastel drawing. No text, no watermarks.');
  });

  it('trims whitespace around the visual prompt', () => {
    const out = buildImagePrompt('  A goblin  ', 'pastel');
    expect(out.startsWith('A goblin.')).toBe(true);
  });

  it('strips a trailing period on the visual prompt before joining', () => {
    const out = buildImagePrompt('A goblin.', 'pastel');
    // We re-add a period after the visual prompt; do not double it up.
    expect(out).toBe('A goblin. Art style: pastel. No text, no watermarks.');
  });

  it('inserts the character appearance clause when provided', () => {
    const out = buildImagePrompt('A goblin in a cave', 'pastel', 'Protagonist: Lyra, a chaotic neutral high elf wizard.');
    expect(out).toContain('Feature the protagonist consistently');
    expect(out).toContain('Protagonist: Lyra');
    expect(out.endsWith('No text, no watermarks.')).toBe(true);
  });

  it('omits the protagonist clause when no appearance is supplied (backward compat)', () => {
    const out = buildImagePrompt('A goblin', 'pastel');
    expect(out).not.toContain('Feature the protagonist');
  });
});

describe('buildCharacterAppearance', () => {
  const baseIdentity = { alignment: 'Chaotic Neutral' };

  it('returns empty string for null/undefined', () => {
    expect(buildCharacterAppearance(null)).toBe('');
    expect(buildCharacterAppearance(undefined)).toBe('');
  });

  it('produces a minimal description with race/class/name/alignment', () => {
    const out = buildCharacterAppearance({
      name: 'Lyra',
      raceSlug: 'high-elf',
      classSlug: 'wizard',
      identity: baseIdentity,
    });
    expect(out).toContain('Lyra');
    expect(out).toContain('high elf');
    expect(out).toContain('wizard');
    expect(out).toContain('chaotic neutral');
  });

  it('includes trait and backstory when present', () => {
    const out = buildCharacterAppearance({
      name: 'Bren',
      raceSlug: 'half-orc',
      classSlug: 'fighter',
      identity: {
        alignment: 'Lawful Good',
        trait: 'Tall, broad-shouldered, scar across left eye',
        backstory: 'Former city guard who fled after a coup.',
      },
    });
    expect(out).toContain('Tall, broad-shouldered');
    expect(out).toContain('Former city guard');
  });

  it('caps trait/backstory length so the prompt stays focused on the scene', () => {
    const long = 'x'.repeat(400);
    const out = buildCharacterAppearance({
      name: 'A',
      raceSlug: 'human',
      classSlug: 'rogue',
      identity: { alignment: 'Neutral', trait: long, backstory: long },
    });
    // Trait + backstory each capped at 220 chars (constant in helper).
    expect(out.match(/x+/g)?.every((s) => s.length <= 220)).toBe(true);
  });
});
