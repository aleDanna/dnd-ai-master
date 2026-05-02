import { describe, it, expect } from 'vitest';
import { slugify } from '@/srd/util/slug';

describe('slugify', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugify('Magic Missile')).toBe('magic-missile');
  });
  it('strips diacritics', () => {
    expect(slugify('Élf')).toBe('elf');
  });
  it('drops apostrophes', () => {
    expect(slugify("Mage's Hand")).toBe('mages-hand');
  });
  it('collapses multiple separators', () => {
    expect(slugify('Hill   Dwarf — variant')).toBe('hill-dwarf-variant');
  });
  it('trims leading/trailing dashes', () => {
    expect(slugify('  Goblin  ')).toBe('goblin');
  });
  it('preserves digits', () => {
    expect(slugify('1d8 Damage')).toBe('1d8-damage');
  });
  it('throws on empty input', () => {
    expect(() => slugify('')).toThrow();
    expect(() => slugify('   ')).toThrow();
  });
});
