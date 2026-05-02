import { randomInt } from 'node:crypto';

export interface Rng {
  /** Return a uniformly-random integer in [min, max] inclusive. */
  intInclusive(min: number, max: number): number;
}

export function createRng(uniform01: () => number): Rng {
  return {
    intInclusive(min, max) {
      if (max < min) throw new Error(`createRng.intInclusive: max (${max}) < min (${min})`);
      const span = max - min + 1;
      return Math.floor(uniform01() * span) + min;
    },
  };
}

/** Default crypto-strong RNG. Used in production. */
export const defaultRng: Rng = {
  intInclusive(min, max) {
    if (max < min) throw new Error(`defaultRng.intInclusive: max (${max}) < min (${min})`);
    return randomInt(min, max + 1);  // node's randomInt is exclusive on max
  },
};

/** Mulberry32-seeded RNG. Deterministic for tests. */
export function makeSeededRng(seed: number): Rng {
  let s = seed >>> 0;
  function next(): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }
  return createRng(next);
}
