import { describe, it, expect } from 'vitest';
import { DEFAULT_PREFERENCES } from '@/lib/preferences';
import { isImageStylePreset } from '@/db/schema/users';

describe('image-generation preferences', () => {
  it('defaults to disabled with pastel preset and empty custom', () => {
    expect(DEFAULT_PREFERENCES.imageGenerationEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.imageStylePreset).toBe('pastel');
    expect(DEFAULT_PREFERENCES.imageStyleCustom).toBe('');
  });

  it('isImageStylePreset accepts the six allowed slugs and rejects others', () => {
    expect(isImageStylePreset('pastel')).toBe(true);
    expect(isImageStylePreset('watercolor')).toBe(true);
    expect(isImageStylePreset('oil')).toBe(true);
    expect(isImageStylePreset('ink')).toBe(true);
    expect(isImageStylePreset('photo')).toBe(true);
    expect(isImageStylePreset('custom')).toBe(true);
    expect(isImageStylePreset('anime')).toBe(false);
    expect(isImageStylePreset(42)).toBe(false);
    expect(isImageStylePreset(undefined)).toBe(false);
  });
});
