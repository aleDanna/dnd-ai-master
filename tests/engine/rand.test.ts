import { describe, it, expect } from 'vitest';
import { createRng, defaultRng, makeSeededRng } from '@/engine/rand';

describe('rand', () => {
  it('default rng produces integers in [min, max] inclusive', () => {
    for (let i = 0; i < 1000; i++) {
      const v = defaultRng.intInclusive(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('seeded rng is deterministic across two instances with the same seed', () => {
    const a = makeSeededRng(42);
    const b = makeSeededRng(42);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 10; i++) {
      seqA.push(a.intInclusive(1, 20));
      seqB.push(b.intInclusive(1, 20));
    }
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences (with overwhelming probability)', () => {
    const a = makeSeededRng(1);
    const b = makeSeededRng(2);
    const seqA = Array.from({ length: 20 }, () => a.intInclusive(1, 100));
    const seqB = Array.from({ length: 20 }, () => b.intInclusive(1, 100));
    expect(seqA).not.toEqual(seqB);
  });

  it('createRng accepts a custom function and uses it', () => {
    let calls = 0;
    const fixed = createRng(() => { calls++; return 0.5; });
    const v = fixed.intInclusive(1, 10);
    // Math.floor(0.5 * 10) + 1 === 6
    expect(v).toBe(6);
    expect(calls).toBe(1);
  });
});
