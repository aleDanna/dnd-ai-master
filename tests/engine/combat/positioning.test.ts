import { describe, expect, it } from 'vitest';
import {
  initialPosition,
  isEngaged,
  movementProvokesOA,
  enterEngagement,
  leaveEngagement,
  bandTransitionDistance,
} from '../../../src/engine/combat/positioning';

describe('positioning — initialPosition', () => {
  it('returns near band by default with no engagement', () => {
    expect(initialPosition()).toEqual({ band: 'near', engagedWith: [] });
  });
});

describe('positioning — isEngaged', () => {
  it('true when engagedWith non-empty', () => {
    expect(isEngaged({ band: 'engaged', engagedWith: ['m1'] })).toBe(true);
  });
  it('false when not engaged', () => {
    expect(isEngaged({ band: 'near', engagedWith: [] })).toBe(false);
  });
});

describe('positioning — movementProvokesOA', () => {
  it('true when leaving engagement without disengage', () => {
    const from = { band: 'engaged' as const, engagedWith: ['m1'] };
    const to = { band: 'near' as const, engagedWith: [] };
    expect(movementProvokesOA(from, to, false)).toEqual(['m1']);
  });
  it('false when disengaged', () => {
    const from = { band: 'engaged' as const, engagedWith: ['m1'] };
    const to = { band: 'near' as const, engagedWith: [] };
    expect(movementProvokesOA(from, to, true)).toEqual([]);
  });
  it('false when not engaged', () => {
    const from = { band: 'near' as const, engagedWith: [] };
    const to = { band: 'far' as const, engagedWith: [] };
    expect(movementProvokesOA(from, to, false)).toEqual([]);
  });
  it('only the enemies you LEFT trigger', () => {
    const from = { band: 'engaged' as const, engagedWith: ['m1', 'm2'] };
    const to = { band: 'engaged' as const, engagedWith: ['m2'] };
    expect(movementProvokesOA(from, to, false)).toEqual(['m1']);
  });
});

describe('positioning — bandTransitionDistance', () => {
  it('engaged → near = 5 ft', () => {
    expect(bandTransitionDistance('engaged', 'near')).toBe(5);
  });
  it('near → far = 25 ft', () => {
    expect(bandTransitionDistance('near', 'far')).toBe(25);
  });
  it('far → distant = 60 ft', () => {
    expect(bandTransitionDistance('far', 'distant')).toBe(60);
  });
  it('same band = 0', () => {
    expect(bandTransitionDistance('near', 'near')).toBe(0);
  });
  it('skipping a band sums', () => {
    expect(bandTransitionDistance('engaged', 'far')).toBe(5 + 25);
  });
  it('reverse direction works', () => {
    expect(bandTransitionDistance('far', 'engaged')).toBe(25 + 5);
  });
});

describe('positioning — enter/leaveEngagement', () => {
  it('enterEngagement adds enemy id and switches band to engaged', () => {
    const p = { band: 'near' as const, engagedWith: [] };
    expect(enterEngagement(p, 'm1')).toEqual({ band: 'engaged', engagedWith: ['m1'] });
  });
  it('enterEngagement is idempotent', () => {
    const p = { band: 'engaged' as const, engagedWith: ['m1'] };
    expect(enterEngagement(p, 'm1')).toEqual(p);
  });
  it('leaveEngagement removes enemy id; band stays engaged if others remain', () => {
    const p = { band: 'engaged' as const, engagedWith: ['m1', 'm2'] };
    expect(leaveEngagement(p, 'm1')).toEqual({ band: 'engaged', engagedWith: ['m2'] });
  });
  it('leaveEngagement reverts band to near when fully disengaged', () => {
    const p = { band: 'engaged' as const, engagedWith: ['m1'] };
    expect(leaveEngagement(p, 'm1')).toEqual({ band: 'near', engagedWith: [] });
  });
});
