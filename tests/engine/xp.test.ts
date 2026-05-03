import { describe, it, expect } from 'vitest';
import { XP_THRESHOLDS, MAX_LEVEL, xpForLevel, xpForNextLevel, xpProgress } from '@/engine/xp';

describe('xp constants', () => {
  it('has 21 entries (level 0 placeholder + 1..20)', () => {
    expect(XP_THRESHOLDS.length).toBe(21);
    expect(MAX_LEVEL).toBe(20);
  });

  it('matches the canonical D&D 5e SRD thresholds at key levels', () => {
    expect(XP_THRESHOLDS[1]).toBe(0);
    expect(XP_THRESHOLDS[2]).toBe(300);
    expect(XP_THRESHOLDS[5]).toBe(6_500);
    expect(XP_THRESHOLDS[11]).toBe(85_000);
    expect(XP_THRESHOLDS[20]).toBe(355_000);
  });

  it('thresholds are strictly increasing from level 1 onward', () => {
    for (let i = 2; i <= MAX_LEVEL; i++) {
      expect(XP_THRESHOLDS[i]!).toBeGreaterThan(XP_THRESHOLDS[i - 1]!);
    }
  });
});

describe('xpForLevel', () => {
  it('returns 0 for level 1', () => {
    expect(xpForLevel(1)).toBe(0);
  });
  it('returns canonical thresholds for mid-tier levels', () => {
    expect(xpForLevel(5)).toBe(6_500);
    expect(xpForLevel(11)).toBe(85_000);
  });
  it('clamps at level 1 floor', () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(-3)).toBe(0);
  });
  it('clamps at level 20 ceiling', () => {
    expect(xpForLevel(21)).toBe(355_000);
    expect(xpForLevel(99)).toBe(355_000);
  });
});

describe('xpForNextLevel', () => {
  it('returns the next threshold for non-capped levels', () => {
    expect(xpForNextLevel(1)).toBe(300);
    expect(xpForNextLevel(4)).toBe(6_500);
  });
  it('returns null at max level', () => {
    expect(xpForNextLevel(20)).toBeNull();
  });
});

describe('xpProgress', () => {
  it('reports zero progress at the level threshold', () => {
    const p = xpProgress(0, 1);
    expect(p.intoLevel).toBe(0);
    expect(p.spanForLevel).toBe(300);
    expect(p.fraction).toBe(0);
    expect(p.atMaxLevel).toBe(false);
  });

  it('reports full progress just under the next threshold', () => {
    const p = xpProgress(299, 1);
    expect(p.intoLevel).toBe(299);
    expect(p.spanForLevel).toBe(300);
    // Almost 1, not quite.
    expect(p.fraction).toBeGreaterThan(0.99);
    expect(p.fraction).toBeLessThan(1);
  });

  it('caps fraction at 1 when xp exceeds the next threshold (level-up pending)', () => {
    // The character has earned enough to level up but level field hasn't been
    // bumped yet. The bar should max out, not overflow.
    const p = xpProgress(350, 1);
    expect(p.fraction).toBe(1);
  });

  it('reports max-level state', () => {
    const p = xpProgress(400_000, 20);
    expect(p.atMaxLevel).toBe(true);
    expect(p.fraction).toBe(1);
    expect(p.nextLevelStart).toBeNull();
    expect(p.spanForLevel).toBe(0);
  });

  it('mid-level progress', () => {
    // Level 4 starts at 2700, level 5 at 6500. Span 3800. At 4500 XP, into=1800.
    const p = xpProgress(4500, 4);
    expect(p.levelStart).toBe(2700);
    expect(p.nextLevelStart).toBe(6500);
    expect(p.intoLevel).toBe(1800);
    expect(p.spanForLevel).toBe(3800);
    expect(p.fraction).toBeCloseTo(1800 / 3800, 4);
  });
});
