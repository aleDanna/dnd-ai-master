// Pure helpers for the exploration layer (PHB §6.1 Travel Pace, §6.4
// Vision/Light, §6.5 Suffocation, §6.6 Falling). The handlers in
// `src/engine/tools/handlers.ts` wrap these with d6 rolls + condition
// mutations; this module only exposes the math/decision logic so it can
// be reused/tested in isolation.

import type { LightLevel, Senses, TravelPace } from './types';

/**
 * PHB §6.1 travel-pace data. The `passivePerceptionMod` is applied as a
 * narrative modifier to passive Perception while travelling at the given
 * pace (Fast travellers are noisy and inattentive — DIS = -5 modifier).
 * Slow pace allows stealth (the party may keep up with a Stealth check).
 */
export interface TravelPaceData {
  /** Feet of overland travel per minute. */
  perMinuteFt: number;
  /** Miles per hour. */
  perHourMi: number;
  /** Miles per day (assuming 8 hours of travel). */
  perDayMi: number;
  /** PHB §6.1: Fast travellers take -5 to passive Perception (DIS). */
  passivePerceptionMod: number;
  /** PHB §6.1: only Slow pace permits Stealth while travelling. */
  stealthAllowed: boolean;
}

export const TRAVEL_PACES: Record<TravelPace, TravelPaceData> = {
  fast: {
    perMinuteFt: 400,
    perHourMi: 4,
    perDayMi: 30,
    passivePerceptionMod: -5,
    stealthAllowed: false,
  },
  normal: {
    perMinuteFt: 300,
    perHourMi: 3,
    perDayMi: 24,
    passivePerceptionMod: 0,
    stealthAllowed: false,
  },
  slow: {
    perMinuteFt: 200,
    perHourMi: 2,
    perDayMi: 18,
    passivePerceptionMod: 0,
    stealthAllowed: true,
  },
};

/**
 * PHB §6.6: a falling creature takes 1d6 bludgeoning damage per 10 feet
 * fallen, to a maximum of 20d6. The creature also lands prone unless
 * negated. Distances <10 ft yield 0 dice (no damage roll). Returns the
 * dice formula components (caller rolls each die).
 *
 *   dice = Math.min(20, Math.floor(distanceFt / 10))
 *   sides = 6
 *   max = dice * 6 (theoretical maximum)
 */
export function fallingDamageFormula(distanceFt: number): {
  dice: number;
  sides: 6;
  max: number;
} {
  const dice = Math.max(0, Math.min(20, Math.floor(distanceFt / 10)));
  return { dice, sides: 6, max: dice * 6 };
}

/**
 * PHB §6.5: a creature can hold its breath for `1 + CON modifier` minutes
 * (minimum 30 seconds). After that, it can survive `CON modifier` rounds
 * (minimum 1 round) at 0 HP before dropping unconscious and starting to
 * suffocate (instant death after the rounds run out — handled by caller).
 *
 *   holdBreathSeconds = max(30, (1 + conMod) * 60)
 *   postBreathRounds  = max(1, conMod)
 */
export interface SuffocationOutcome {
  holdBreathSeconds: number;
  postBreathRounds: number;
}

export function suffocationSurvival(conMod: number): SuffocationOutcome {
  return {
    holdBreathSeconds: Math.max(30, (1 + conMod) * 60),
    postBreathRounds: Math.max(1, conMod),
  };
}

/**
 * PHB §6.4 light-level effects on Perception checks relying on sight.
 *
 * - **Bright light**: normal vision; no penalty.
 * - **Dim light** (lightly obscured): DIS on Perception checks relying
 *   on sight. Darkvision treats dim as bright within range — no penalty.
 * - **Darkness** (heavily obscured): effectively blinded. Darkvision
 *   sees darkness as dim within range — DIS on Perception, NOT blinded.
 * - **Truesight** within range overrides everything: sees as if in
 *   bright light, regardless of magical or non-magical darkness.
 *
 * Returns two flags the caller can apply to Perception roll mechanics:
 *   - `perceptionDisadvantage`: roll Perception with disadvantage
 *   - `effectivelyBlinded`: target heavily obscured; auto-fail sight
 *     checks, attacks against the observer have ADV, observer has DIS
 *     to see anything in that area
 */
export interface VisionEffects {
  perceptionDisadvantage: boolean;
  effectivelyBlinded: boolean;
}

export function lightEffects(
  level: LightLevel,
  observerSenses: Senses,
  distanceFt: number,
): VisionEffects {
  // Truesight wins everywhere within its range — magical or non-magical
  // darkness, including invisibility (per PHB §6.4 "Senses").
  if ((observerSenses.truesightFt ?? 0) >= distanceFt) {
    return { perceptionDisadvantage: false, effectivelyBlinded: false };
  }

  if (level === 'bright') {
    return { perceptionDisadvantage: false, effectivelyBlinded: false };
  }

  if (level === 'dim') {
    // Dim = lightly obscured. Darkvision treats dim as bright within range.
    if ((observerSenses.darkvisionFt ?? 0) >= distanceFt) {
      return { perceptionDisadvantage: false, effectivelyBlinded: false };
    }
    // No darkvision (or out of range): DIS on Perception, NOT blinded.
    return { perceptionDisadvantage: true, effectivelyBlinded: false };
  }

  // level === 'darkness': heavily obscured.
  // Darkvision sees darkness AS dim within range → DIS on Perception, not
  // blinded. Out of darkvision range or no darkvision: effectively blinded.
  if ((observerSenses.darkvisionFt ?? 0) >= distanceFt) {
    return { perceptionDisadvantage: true, effectivelyBlinded: false };
  }
  return { perceptionDisadvantage: true, effectivelyBlinded: true };
}
