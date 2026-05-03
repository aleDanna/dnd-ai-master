/**
 * D&D 5e SRD experience point thresholds.
 *
 * Index = level. XP_THRESHOLDS[L] is the cumulative XP required to BE at
 * level L. So a character with 0 XP is at level 1; reaching 300 XP qualifies
 * for level 2; and so on. Level 20 is the cap.
 *
 * Source: SRD 5.1 — "Character Advancement" table.
 */
export const XP_THRESHOLDS: readonly number[] = [
  0,         // (unused — there is no "level 0")
  0,         // 1
  300,       // 2
  900,       // 3
  2_700,     // 4
  6_500,     // 5
  14_000,    // 6
  23_000,    // 7
  34_000,    // 8
  48_000,    // 9
  64_000,    // 10
  85_000,    // 11
  100_000,   // 12
  120_000,   // 13
  140_000,   // 14
  165_000,   // 15
  195_000,   // 16
  225_000,   // 17
  265_000,   // 18
  305_000,   // 19
  355_000,   // 20
] as const;

export const MAX_LEVEL = XP_THRESHOLDS.length - 1; // 20

/** XP required to BE at the given level. Clamped to [1, MAX_LEVEL]. */
export function xpForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return XP_THRESHOLDS[clamped]!;
}

/** XP required to ADVANCE to the level after `currentLevel`. Returns null
 *  when already at max level — there's nothing higher to progress toward. */
export function xpForNextLevel(currentLevel: number): number | null {
  if (currentLevel >= MAX_LEVEL) return null;
  const next = Math.max(1, Math.floor(currentLevel)) + 1;
  return XP_THRESHOLDS[next] ?? null;
}

export interface XpProgress {
  /** Total cumulative XP. */
  xp: number;
  /** Current level (1-20). */
  level: number;
  /** XP required to be at the current level. */
  levelStart: number;
  /** XP required to reach the next level, or null at max level. */
  nextLevelStart: number | null;
  /** XP earned within the current level (xp - levelStart). 0 at the threshold. */
  intoLevel: number;
  /** XP needed to span the current level (nextLevelStart - levelStart). 0 at max. */
  spanForLevel: number;
  /** Fraction completed within the current level, [0, 1]. 1 at max level. */
  fraction: number;
  /** True when the character is at max level (no further progression). */
  atMaxLevel: boolean;
}

/**
 * Compute progress within the current level given a cumulative XP total.
 * Useful for rendering a progress bar from levelStart to nextLevelStart.
 *
 * Note: this does NOT auto-detect level-ups from xp. The character's `level`
 * field is the source of truth and is bumped explicitly via the `level_up`
 * mutation. If you pass an xp that's beyond the next threshold, `fraction`
 * is capped at 1 so the bar maxes out (a visual hint that a level-up is
 * pending) rather than overflowing.
 */
export function xpProgress(xp: number, level: number): XpProgress {
  const safeLevel = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  const safeXp = Math.max(0, Math.floor(xp));
  const levelStart = xpForLevel(safeLevel);
  const nextLevelStart = xpForNextLevel(safeLevel);
  const atMaxLevel = nextLevelStart === null;
  const intoLevel = Math.max(0, safeXp - levelStart);
  const spanForLevel = atMaxLevel ? 0 : (nextLevelStart - levelStart);
  const fraction = atMaxLevel ? 1 : spanForLevel <= 0 ? 0 : Math.min(1, intoLevel / spanForLevel);
  return {
    xp: safeXp,
    level: safeLevel,
    levelStart,
    nextLevelStart,
    intoLevel,
    spanForLevel,
    fraction,
    atMaxLevel,
  };
}
