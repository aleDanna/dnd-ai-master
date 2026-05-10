import { describe, it, expect } from 'vitest';
import { coverAcBonus, coverDexSaveBonus, isTotalCover } from '@/engine/combat/cover';

describe('cover helpers (PHB §3.12)', () => {
  it('coverAcBonus(none) = 0', () => {
    expect(coverAcBonus('none')).toBe(0);
  });

  it('coverAcBonus(half) = +2', () => {
    expect(coverAcBonus('half')).toBe(2);
  });

  it('coverAcBonus(three-quarters) = +5', () => {
    expect(coverAcBonus('three-quarters')).toBe(5);
  });

  it('coverAcBonus(total) = Infinity (cannot be hit)', () => {
    expect(coverAcBonus('total')).toBe(Infinity);
  });

  it('coverDexSaveBonus mirrors AC bonus', () => {
    expect(coverDexSaveBonus('none')).toBe(0);
    expect(coverDexSaveBonus('half')).toBe(2);
    expect(coverDexSaveBonus('three-quarters')).toBe(5);
    expect(coverDexSaveBonus('total')).toBe(Infinity);
  });

  it('isTotalCover detects only total', () => {
    expect(isTotalCover('total')).toBe(true);
    expect(isTotalCover('half')).toBe(false);
    expect(isTotalCover('three-quarters')).toBe(false);
    expect(isTotalCover('none')).toBe(false);
    expect(isTotalCover(undefined)).toBe(false);
  });
});
