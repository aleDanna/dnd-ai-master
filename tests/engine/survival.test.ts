import { describe, expect, it } from 'vitest';
import {
  dehydrationSaveDC,
  forcedMarchDC,
  starvationSurvivalDays,
} from '@/engine/survival';

describe('forcedMarchDC (PHB §6.3)', () => {
  it('returns 0 if ≤8 hours (no save)', () => {
    expect(forcedMarchDC(8)).toBe(0);
    expect(forcedMarchDC(0)).toBe(0);
    expect(forcedMarchDC(7)).toBe(0);
  });

  it('returns 11 at 9 hours', () => {
    expect(forcedMarchDC(9)).toBe(11);
  });

  it('returns 12 at 10 hours', () => {
    expect(forcedMarchDC(10)).toBe(12);
  });

  it('returns 18 at 16 hours', () => {
    expect(forcedMarchDC(16)).toBe(18);
  });
});

describe('starvationSurvivalDays (PHB §6.7)', () => {
  it('returns 4 for CON +1', () => {
    expect(starvationSurvivalDays(1)).toBe(4);
  });

  it('returns 3 for CON 0', () => {
    expect(starvationSurvivalDays(0)).toBe(3);
  });

  it('returns 1 (minimum) for CON -3', () => {
    expect(starvationSurvivalDays(-3)).toBe(1);
  });

  it('returns 1 (minimum) for CON -10', () => {
    expect(starvationSurvivalDays(-10)).toBe(1);
  });

  it('returns 8 for CON +5', () => {
    expect(starvationSurvivalDays(5)).toBe(8);
  });
});

describe('dehydrationSaveDC (PHB §6.7)', () => {
  it('returns 15 day 1', () => {
    expect(dehydrationSaveDC(1)).toBe(15);
  });

  it('returns 20 day 2', () => {
    expect(dehydrationSaveDC(2)).toBe(20);
  });

  it('returns 25 day 3', () => {
    expect(dehydrationSaveDC(3)).toBe(25);
  });
});
