// Pure helpers for travel & survival mechanics (PHB §6.3 Forced March,
// §6.7 Food and Water). The handlers in `src/engine/tools/handlers.ts`
// wrap these with d20 rolls + exhaustion mutations; this module only
// exposes the math so it can be reused/tested in isolation.

/**
 * PHB §6.3: when a creature travels for more than 8 hours in a day, at the
 * end of each hour past the 8th they must succeed on a Constitution saving
 * throw or suffer 1 level of exhaustion. The DC is `10 + 1 per hour past 8`.
 *
 * Returns 0 when no save is required (≤ 8 hours of travel).
 */
export function forcedMarchDC(hoursTraveled: number): number {
  if (hoursTraveled <= 8) return 0;
  return 10 + (hoursTraveled - 8);
}

/**
 * PHB §6.7 (Food): a creature can survive without food for `3 + CON modifier`
 * days (minimum 1). After this threshold every additional day automatically
 * applies 1 level of exhaustion (no save).
 */
export function starvationSurvivalDays(conMod: number): number {
  return Math.max(1, 3 + conMod);
}

/**
 * PHB §6.7 (Water): a creature that drinks less than half the daily water
 * requirement makes a Constitution saving throw at the end of the day.
 * The DC is 15 on the first day and increases by 5 for each consecutive
 * day with less than half water.
 */
export function dehydrationSaveDC(consecutiveDaysWithLessThanHalfWater: number): number {
  return 15 + Math.max(0, consecutiveDaysWithLessThanHalfWater - 1) * 5;
}
