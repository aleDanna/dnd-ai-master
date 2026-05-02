import {
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  POINT_BUY_MAX,
  POINT_BUY_MIN,
  STANDARD_ARRAY,
  type WizardAbilities,
} from './types';

/** Total points spent (Infinity if any score is outside the cost table). */
export function pointBuySpent(abilities: WizardAbilities): number {
  let spent = 0;
  for (const v of Object.values(abilities)) {
    const cost = POINT_BUY_COST[v];
    if (cost === undefined) return Infinity;
    spent += cost;
  }
  return spent;
}

export function pointBuyRemaining(abilities: WizardAbilities): number {
  return POINT_BUY_BUDGET - pointBuySpent(abilities);
}

/** A complete, in-budget point-buy distribution: every score in [8..15], total spent === 27. */
export function isCompletePointBuy(abilities: WizardAbilities): boolean {
  for (const v of Object.values(abilities)) {
    if (v < POINT_BUY_MIN || v > POINT_BUY_MAX) return false;
  }
  return pointBuySpent(abilities) === POINT_BUY_BUDGET;
}

/** Cost to bump a score from `from` to `to`. Returns Infinity if the move would exit the table. */
export function pointBuyCostDelta(from: number, to: number): number {
  const a = POINT_BUY_COST[from];
  const b = POINT_BUY_COST[to];
  if (a === undefined || b === undefined) return Infinity;
  return b - a;
}

/** Has the user assigned each standard-array value exactly once? */
export function isCompleteStandardArray(abilities: WizardAbilities): boolean {
  const values = Object.values(abilities).slice().sort((a, b) => b - a);
  const expected = STANDARD_ARRAY.slice().sort((a, b) => b - a);
  if (values.length !== expected.length) return false;
  return values.every((v, i) => v === expected[i]);
}

/** Roll 4d6, drop the lowest, sum the top three. Pure given an injected RNG. */
export function roll4d6DropLowest(rng: () => number = Math.random): number {
  const rolls = [
    Math.floor(rng() * 6) + 1,
    Math.floor(rng() * 6) + 1,
    Math.floor(rng() * 6) + 1,
    Math.floor(rng() * 6) + 1,
  ];
  rolls.sort((a, b) => b - a);
  return rolls[0]! + rolls[1]! + rolls[2]!;
}

/** Generate six ability-score values via 4d6-drop-lowest, sorted descending. */
export function rollSixAbilityValues(rng: () => number = Math.random): number[] {
  return [0, 0, 0, 0, 0, 0].map(() => roll4d6DropLowest(rng)).sort((a, b) => b - a);
}

/**
 * For a "roll" assignment to be complete the user must have assigned every rolled value
 * exactly once. The `pool` is the rolled values and `abilities` is the current assignment.
 */
export function isCompleteRollAssignment(abilities: WizardAbilities, pool: number[]): boolean {
  if (pool.length !== 6) return false;
  const values = Object.values(abilities).slice().sort((a, b) => b - a);
  const expected = pool.slice().sort((a, b) => b - a);
  return values.every((v, i) => v === expected[i]);
}
