import { describe, it, expect } from 'vitest';
import { resolveStyleText, buildImagePrompt } from '@/ai/master/image-style';
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
});
