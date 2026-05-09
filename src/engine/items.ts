import type { Rarity } from './types';

/**
 * PHB §10.1 rarity ladder, ordered from least to most rare. The position in
 * the array IS the tier (common = 0, artifact = 5).
 */
const RARITY_ORDER: Rarity[] = [
  'common',
  'uncommon',
  'rare',
  'very_rare',
  'legendary',
  'artifact',
];

/**
 * Return the numeric tier (0..5) for a given rarity. Used to sort, compare,
 * and gate access to items beyond the party's level.
 */
export function rarityTier(r: Rarity): number {
  return RARITY_ORDER.indexOf(r);
}

/**
 * Compare two rarities. Returns -1 when `a` is rarer than `b` is not (i.e.
 * `a < b`), 0 if equal, and 1 when `a` is rarer.
 */
export function rarityComparedTo(a: Rarity, b: Rarity): -1 | 0 | 1 {
  const ai = rarityTier(a);
  const bi = rarityTier(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * PHB §10.1 reference sale price (in gp). These are the midpoint values from
 * the magic-item-creation table (Common 50-100, Uncommon 101-500, Rare
 * 501-5,000, Very Rare 5,001-50,000, Legendary 50,001+). Artifacts return -1
 * because they are explicitly priceless / unique. Informational only — no
 * currency mutation is gated on this.
 */
export function rarityRefSalePrice(r: Rarity): number {
  switch (r) {
    case 'common':
      return 100;
    case 'uncommon':
      return 400;
    case 'rare':
      return 4_000;
    case 'very_rare':
      return 40_000;
    case 'legendary':
      return 200_000;
    case 'artifact':
      return -1;
  }
}

/**
 * PHB §10.1 attunement cap: a creature can be attuned to AT MOST 3 magic
 * items at the same time. Tools and applicator both consult this constant —
 * do not hardcode 3 elsewhere.
 */
export const MAX_ATTUNED = 3;
