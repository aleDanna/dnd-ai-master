import type { CoverLevel } from '../types';

/**
 * PHB §3.12 — cover bonus to AC vs attacks.
 * - none: 0
 * - half (low wall, large furniture, narrow tree, creature in the way): +2
 * - three-quarters (portcullis, arrow slit, thick tree): +5
 * - total (cannot be targeted at all): Infinity (sentinel)
 */
export function coverAcBonus(cover: CoverLevel): number {
  switch (cover) {
    case 'none':
      return 0;
    case 'half':
      return 2;
    case 'three-quarters':
      return 5;
    case 'total':
      return Infinity;
  }
}

/**
 * PHB §3.12 — same numeric bonus applied to DEX saves vs AoE effects
 * originating from the OTHER side of the cover (e.g. fireball through a
 * doorway). Mirror the AC bonus.
 */
export function coverDexSaveBonus(cover: CoverLevel): number {
  return coverAcBonus(cover);
}

/**
 * Convenience guard for the total-cover branch (which short-circuits the
 * attack resolver without consuming the actor's action).
 */
export function isTotalCover(cover: CoverLevel | undefined): boolean {
  return cover === 'total';
}
