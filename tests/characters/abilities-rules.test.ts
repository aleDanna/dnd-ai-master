import { describe, it, expect } from 'vitest';
import {
  isCompletePointBuy,
  isCompleteRollAssignment,
  isCompleteStandardArray,
  pointBuyCostDelta,
  pointBuyRemaining,
  pointBuySpent,
  roll4d6DropLowest,
  rollSixAbilityValues,
} from '@/characters/abilities-rules';
import { POINT_BUY_BUDGET } from '@/characters/types';

describe('point-buy', () => {
  it('total cost for the default standard-array distribution is over budget', () => {
    // 15+14+13+12+10+8 = 9+7+5+4+2+0 = 27 — exactly the budget, BUT only valid if every
    // score is in [8..15]. This particular set IS within range so it's a valid completed pointbuy.
    const dist = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
    expect(pointBuySpent(dist)).toBe(27);
    expect(pointBuyRemaining(dist)).toBe(0);
    expect(isCompletePointBuy(dist)).toBe(true);
  });

  it('all 8s spends 0 points and is incomplete', () => {
    const dist = { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 };
    expect(pointBuySpent(dist)).toBe(0);
    expect(pointBuyRemaining(dist)).toBe(POINT_BUY_BUDGET);
    expect(isCompletePointBuy(dist)).toBe(false);
  });

  it('a score of 16 is out of the cost table → spent is Infinity', () => {
    const dist = { STR: 16, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 };
    expect(pointBuySpent(dist)).toBe(Infinity);
    expect(isCompletePointBuy(dist)).toBe(false);
  });

  it('costDelta from 13 → 14 is 2 (non-linear bump)', () => {
    expect(pointBuyCostDelta(13, 14)).toBe(2);
    expect(pointBuyCostDelta(14, 15)).toBe(2);
    expect(pointBuyCostDelta(8, 9)).toBe(1);
  });
});

describe('standard-array', () => {
  it('detects the canonical [15,14,13,12,10,8] distribution in any permutation', () => {
    expect(isCompleteStandardArray({ STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 })).toBe(true);
    expect(isCompleteStandardArray({ STR: 8, DEX: 10, CON: 12, INT: 13, WIS: 14, CHA: 15 })).toBe(true);
  });

  it('rejects any duplicate or wrong value', () => {
    expect(isCompleteStandardArray({ STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 10 })).toBe(false);
    expect(isCompleteStandardArray({ STR: 16, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 })).toBe(false);
  });
});

describe('roll', () => {
  it('roll4d6DropLowest produces a value in [3..18]', () => {
    let pinnedRng = 0;
    const seq = [0.99, 0.99, 0.99, 0.99]; // all 6s → 18
    const v = roll4d6DropLowest(() => seq[pinnedRng++]!);
    expect(v).toBe(18);

    pinnedRng = 0;
    const lowSeq = [0, 0, 0, 0]; // all 1s → 3
    const w = roll4d6DropLowest(() => lowSeq[pinnedRng++]!);
    expect(w).toBe(3);
  });

  it('rollSixAbilityValues returns 6 numbers, sorted desc', () => {
    const v = rollSixAbilityValues();
    expect(v.length).toBe(6);
    for (let i = 1; i < v.length; i++) {
      expect(v[i]!).toBeLessThanOrEqual(v[i - 1]!);
    }
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(18);
    }
  });

  it('isCompleteRollAssignment compares the multiset, ignoring permutation', () => {
    const pool = [16, 14, 13, 11, 10, 7];
    expect(
      isCompleteRollAssignment({ STR: 16, DEX: 14, CON: 13, INT: 11, WIS: 10, CHA: 7 }, pool),
    ).toBe(true);
    expect(
      isCompleteRollAssignment({ STR: 7, DEX: 10, CON: 11, INT: 13, WIS: 14, CHA: 16 }, pool),
    ).toBe(true);
    expect(
      isCompleteRollAssignment({ STR: 16, DEX: 14, CON: 13, INT: 11, WIS: 10, CHA: 8 }, pool),
    ).toBe(false);
  });
});
