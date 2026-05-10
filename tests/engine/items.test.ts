import { describe, it, expect } from 'vitest';
import {
  rarityTier,
  rarityComparedTo,
  rarityRefSalePrice,
  MAX_ATTUNED,
} from '@/engine/items';
import type { Rarity } from '@/engine/types';

describe('engine/items: rarity helpers', () => {
  it('rarityTier orders common (0) → artifact (5)', () => {
    expect(rarityTier('common')).toBe(0);
    expect(rarityTier('uncommon')).toBe(1);
    expect(rarityTier('rare')).toBe(2);
    expect(rarityTier('very_rare')).toBe(3);
    expect(rarityTier('legendary')).toBe(4);
    expect(rarityTier('artifact')).toBe(5);
  });

  it('rarityComparedTo returns -1 / 0 / 1 in tier order', () => {
    expect(rarityComparedTo('common', 'rare')).toBe(-1);
    expect(rarityComparedTo('rare', 'rare')).toBe(0);
    expect(rarityComparedTo('legendary', 'uncommon')).toBe(1);
    expect(rarityComparedTo('artifact', 'common')).toBe(1);
    expect(rarityComparedTo('common', 'artifact')).toBe(-1);
  });

  it('rarityComparedTo is monotonic across the whole ladder', () => {
    const ladder: Rarity[] = [
      'common',
      'uncommon',
      'rare',
      'very_rare',
      'legendary',
      'artifact',
    ];
    for (let i = 0; i < ladder.length; i++) {
      for (let j = 0; j < ladder.length; j++) {
        const expected = i < j ? -1 : i > j ? 1 : 0;
        expect(rarityComparedTo(ladder[i]!, ladder[j]!)).toBe(expected);
      }
    }
  });

  it('rarityRefSalePrice returns PHB midpoints, -1 for artifact', () => {
    expect(rarityRefSalePrice('common')).toBe(100);
    expect(rarityRefSalePrice('uncommon')).toBe(400);
    expect(rarityRefSalePrice('rare')).toBe(4_000);
    expect(rarityRefSalePrice('very_rare')).toBe(40_000);
    expect(rarityRefSalePrice('legendary')).toBe(200_000);
    expect(rarityRefSalePrice('artifact')).toBe(-1);
  });

  it('rarityRefSalePrice is strictly monotonic for non-artifact rarities', () => {
    const ladder: Rarity[] = [
      'common',
      'uncommon',
      'rare',
      'very_rare',
      'legendary',
    ];
    for (let i = 1; i < ladder.length; i++) {
      const prev = rarityRefSalePrice(ladder[i - 1]!);
      const cur = rarityRefSalePrice(ladder[i]!);
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it('MAX_ATTUNED equals 3 (PHB §10.1)', () => {
    expect(MAX_ATTUNED).toBe(3);
  });
});
