import { describe, expect, it } from 'vitest';
import {
  CRAFTING_KINDS,
  CRAFTABLE_RARITIES,
  isValidCraftingKind,
  isValidCraftableRarity,
  magicItemCraftingRequirements,
  nonMagicalCraftingRequirements,
  potionCraftingRequirements,
  scrollCraftingRequirements,
} from '@/engine/crafting';

describe('nonMagicalCraftingRequirements (PHB §5)', () => {
  it('15 gp longsword → 30 days / 8 gp', () => {
    // ceil(15 × 2) = 30 days; ceil(15 / 2) = 8 gp.
    expect(nonMagicalCraftingRequirements(15)).toEqual({ daysRequired: 30, gpRequired: 8 });
  });

  it('14 gp item → 28 days / 7 gp (clean halves)', () => {
    expect(nonMagicalCraftingRequirements(14)).toEqual({ daysRequired: 28, gpRequired: 7 });
  });

  it('1 gp item → 2 days / 1 gp', () => {
    // ceil(1 × 2) = 2 days; ceil(1 / 2) = 1 gp.
    expect(nonMagicalCraftingRequirements(1)).toEqual({ daysRequired: 2, gpRequired: 1 });
  });

  it('0 gp item → minimum 1 day / 0 gp', () => {
    expect(nonMagicalCraftingRequirements(0)).toEqual({ daysRequired: 1, gpRequired: 0 });
  });

  it('rounds up fractional inputs (price 0.4 gp → 1 day / 1 gp)', () => {
    // ceil(0.4 × 2) = ceil(0.8) = 1; ceil(0.4 / 2) = ceil(0.2) = 1.
    // Min-day clamp irrelevant since ceil already returns 1.
    expect(nonMagicalCraftingRequirements(0.4)).toEqual({ daysRequired: 1, gpRequired: 1 });
  });

  it('expensive 500 gp plate → 1000 days / 250 gp', () => {
    expect(nonMagicalCraftingRequirements(500)).toEqual({ daysRequired: 1000, gpRequired: 250 });
  });

  it('negative or NaN inputs clamp to 0 → 1 day / 0 gp', () => {
    expect(nonMagicalCraftingRequirements(-5)).toEqual({ daysRequired: 1, gpRequired: 0 });
    expect(nonMagicalCraftingRequirements(Number.NaN)).toEqual({
      daysRequired: 1,
      gpRequired: 0,
    });
  });
});

describe('magicItemCraftingRequirements (DMG)', () => {
  it('common → 4 days / 50 gp', () => {
    expect(magicItemCraftingRequirements('common')).toEqual({ daysRequired: 4, gpRequired: 50 });
  });

  it('uncommon → 20 days / 200 gp', () => {
    expect(magicItemCraftingRequirements('uncommon')).toEqual({
      daysRequired: 20,
      gpRequired: 200,
    });
  });

  it('rare → 100 days / 2 000 gp', () => {
    expect(magicItemCraftingRequirements('rare')).toEqual({
      daysRequired: 100,
      gpRequired: 2_000,
    });
  });

  it('very_rare → 500 days / 20 000 gp', () => {
    expect(magicItemCraftingRequirements('very_rare')).toEqual({
      daysRequired: 500,
      gpRequired: 20_000,
    });
  });

  it('legendary → 2 500 days / 100 000 gp', () => {
    expect(magicItemCraftingRequirements('legendary')).toEqual({
      daysRequired: 2_500,
      gpRequired: 100_000,
    });
  });
});

describe('scrollCraftingRequirements (PHB §11 / Xanathar)', () => {
  it('cantrip (L0) → 1 day / 15 gp', () => {
    expect(scrollCraftingRequirements(0)).toEqual({ daysRequired: 1, gpRequired: 15 });
  });

  it('L1 → max(2, 2) = 2 days / 50 gp', () => {
    expect(scrollCraftingRequirements(1)).toEqual({ daysRequired: 2, gpRequired: 50 });
  });

  it('L3 → 6 days / 250 gp', () => {
    // 9 × 25 + 25 = 250
    expect(scrollCraftingRequirements(3)).toEqual({ daysRequired: 6, gpRequired: 250 });
  });

  it('L5 → 10 days / 650 gp', () => {
    // 25 × 25 + 25 = 650
    expect(scrollCraftingRequirements(5)).toEqual({ daysRequired: 10, gpRequired: 650 });
  });

  it('L9 → 18 days / 2 050 gp', () => {
    // 81 × 25 + 25 = 2050
    expect(scrollCraftingRequirements(9)).toEqual({ daysRequired: 18, gpRequired: 2_050 });
  });
});

describe('potionCraftingRequirements', () => {
  it('L0 / cantrip-fueled → common (4 / 50)', () => {
    expect(potionCraftingRequirements(0)).toEqual({ daysRequired: 4, gpRequired: 50 });
  });

  it('L1 → common (4 / 50)', () => {
    expect(potionCraftingRequirements(1)).toEqual({ daysRequired: 4, gpRequired: 50 });
  });

  it('L2 → uncommon (20 / 200)', () => {
    expect(potionCraftingRequirements(2)).toEqual({ daysRequired: 20, gpRequired: 200 });
  });

  it('L3 → uncommon (20 / 200)', () => {
    expect(potionCraftingRequirements(3)).toEqual({ daysRequired: 20, gpRequired: 200 });
  });

  it('L4 → rare (100 / 2 000)', () => {
    expect(potionCraftingRequirements(4)).toEqual({ daysRequired: 100, gpRequired: 2_000 });
  });

  it('L5 → rare (100 / 2 000)', () => {
    expect(potionCraftingRequirements(5)).toEqual({ daysRequired: 100, gpRequired: 2_000 });
  });

  it('L6 → very_rare (500 / 20 000)', () => {
    expect(potionCraftingRequirements(6)).toEqual({ daysRequired: 500, gpRequired: 20_000 });
  });

  it('L9 → very_rare (500 / 20 000)', () => {
    expect(potionCraftingRequirements(9)).toEqual({ daysRequired: 500, gpRequired: 20_000 });
  });
});

describe('validators', () => {
  it('CRAFTING_KINDS exposes the 4 legal kinds', () => {
    expect(CRAFTING_KINDS).toEqual(['item', 'magic_item', 'scroll', 'potion']);
  });

  it('isValidCraftingKind accepts the 4 known kinds and rejects others', () => {
    for (const kind of CRAFTING_KINDS) {
      expect(isValidCraftingKind(kind)).toBe(true);
    }
    expect(isValidCraftingKind('weapon')).toBe(false);
    expect(isValidCraftingKind('')).toBe(false);
    expect(isValidCraftingKind(undefined)).toBe(false);
    expect(isValidCraftingKind(null)).toBe(false);
    expect(isValidCraftingKind(42)).toBe(false);
  });

  it('CRAFTABLE_RARITIES excludes artifact', () => {
    expect(CRAFTABLE_RARITIES).toEqual([
      'common',
      'uncommon',
      'rare',
      'very_rare',
      'legendary',
    ]);
  });

  it('isValidCraftableRarity rejects "artifact" and unknown values', () => {
    for (const r of CRAFTABLE_RARITIES) {
      expect(isValidCraftableRarity(r)).toBe(true);
    }
    expect(isValidCraftableRarity('artifact')).toBe(false);
    expect(isValidCraftableRarity('mythic')).toBe(false);
    expect(isValidCraftableRarity(undefined)).toBe(false);
  });
});
