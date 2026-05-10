import { describe, expect, it } from 'vitest';
import {
  TRAVEL_PACES,
  fallingDamageFormula,
  suffocationSurvival,
  lightEffects,
} from '@/engine/exploration';
import type { Senses } from '@/engine/types';

// ─── TRAVEL_PACES (PHB §6.1) ───────────────────────────────────────────────

describe('TRAVEL_PACES (PHB §6.1)', () => {
  it('Fast: 4 mi/h, 30 mi/day, -5 passive Perception, no stealth', () => {
    expect(TRAVEL_PACES.fast).toEqual({
      perMinuteFt: 400,
      perHourMi: 4,
      perDayMi: 30,
      passivePerceptionMod: -5,
      stealthAllowed: false,
    });
  });

  it('Normal: 3 mi/h, 24 mi/day, baseline (0 mod), no stealth', () => {
    expect(TRAVEL_PACES.normal).toEqual({
      perMinuteFt: 300,
      perHourMi: 3,
      perDayMi: 24,
      passivePerceptionMod: 0,
      stealthAllowed: false,
    });
  });

  it('Slow: 2 mi/h, 18 mi/day, baseline (0 mod), stealth allowed', () => {
    expect(TRAVEL_PACES.slow).toEqual({
      perMinuteFt: 200,
      perHourMi: 2,
      perDayMi: 18,
      passivePerceptionMod: 0,
      stealthAllowed: true,
    });
  });
});

// ─── fallingDamageFormula (PHB §6.6) ───────────────────────────────────────

describe('fallingDamageFormula (PHB §6.6)', () => {
  it('0ft fall yields 0 dice (no damage)', () => {
    expect(fallingDamageFormula(0)).toEqual({ dice: 0, sides: 6, max: 0 });
  });

  it('5ft fall yields 0 dice (must reach 10 ft)', () => {
    expect(fallingDamageFormula(5)).toEqual({ dice: 0, sides: 6, max: 0 });
  });

  it('10ft fall yields 1d6', () => {
    expect(fallingDamageFormula(10)).toEqual({ dice: 1, sides: 6, max: 6 });
  });

  it('30ft fall yields 3d6', () => {
    expect(fallingDamageFormula(30)).toEqual({ dice: 3, sides: 6, max: 18 });
  });

  it('45ft fall yields 4d6 (rounds down to nearest 10)', () => {
    expect(fallingDamageFormula(45)).toEqual({ dice: 4, sides: 6, max: 24 });
  });

  it('200ft fall yields 20d6 (cap)', () => {
    expect(fallingDamageFormula(200)).toEqual({ dice: 20, sides: 6, max: 120 });
  });

  it('250ft fall caps at 20d6', () => {
    expect(fallingDamageFormula(250)).toEqual({ dice: 20, sides: 6, max: 120 });
  });

  it('1000ft fall caps at 20d6', () => {
    expect(fallingDamageFormula(1000)).toEqual({ dice: 20, sides: 6, max: 120 });
  });

  it('negative distance is clamped to 0 dice', () => {
    expect(fallingDamageFormula(-15)).toEqual({ dice: 0, sides: 6, max: 0 });
  });
});

// ─── suffocationSurvival (PHB §6.5) ────────────────────────────────────────

describe('suffocationSurvival (PHB §6.5)', () => {
  it('CON +0: 60s hold breath, 1 round post-breath (min)', () => {
    expect(suffocationSurvival(0)).toEqual({
      holdBreathSeconds: 60,
      postBreathRounds: 1,
    });
  });

  it('CON +1: 120s hold breath, 1 round post-breath', () => {
    expect(suffocationSurvival(1)).toEqual({
      holdBreathSeconds: 120,
      postBreathRounds: 1,
    });
  });

  it('CON +3: 240s hold breath, 3 rounds post-breath', () => {
    expect(suffocationSurvival(3)).toEqual({
      holdBreathSeconds: 240,
      postBreathRounds: 3,
    });
  });

  it('CON +5: 360s hold breath, 5 rounds post-breath', () => {
    expect(suffocationSurvival(5)).toEqual({
      holdBreathSeconds: 360,
      postBreathRounds: 5,
    });
  });

  it('CON -1: 30s hold breath (min), 1 round post-breath (min)', () => {
    expect(suffocationSurvival(-1)).toEqual({
      holdBreathSeconds: 30,
      postBreathRounds: 1,
    });
  });

  it('CON -3: 30s hold breath (min), 1 round post-breath (min)', () => {
    expect(suffocationSurvival(-3)).toEqual({
      holdBreathSeconds: 30,
      postBreathRounds: 1,
    });
  });
});

// ─── lightEffects (PHB §6.4) ───────────────────────────────────────────────

describe('lightEffects (PHB §6.4)', () => {
  const noSenses: Senses = {};

  it('bright light: no penalty regardless of senses or distance', () => {
    expect(lightEffects('bright', noSenses, 10)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
    expect(lightEffects('bright', { darkvisionFt: 60 }, 100)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
  });

  it('dim, no darkvision: DIS on Perception, not blinded', () => {
    expect(lightEffects('dim', noSenses, 30)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
    });
  });

  it('dim, with darkvision in range: no penalty (treats dim as bright)', () => {
    expect(lightEffects('dim', { darkvisionFt: 60 }, 30)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
    expect(lightEffects('dim', { darkvisionFt: 60 }, 60)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
  });

  it('dim, with darkvision out of range: DIS on Perception (treats as dim)', () => {
    expect(lightEffects('dim', { darkvisionFt: 60 }, 90)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
    });
  });

  it('darkness, no darkvision: blinded + DIS on Perception', () => {
    expect(lightEffects('darkness', noSenses, 30)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: true,
    });
  });

  it('darkness, darkvision in range: DIS on Perception, NOT blinded (treats as dim)', () => {
    expect(lightEffects('darkness', { darkvisionFt: 60 }, 30)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
    });
  });

  it('darkness, darkvision out of range: blinded + DIS', () => {
    expect(lightEffects('darkness', { darkvisionFt: 60 }, 90)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: true,
    });
  });

  it('truesight overrides bright light (no penalty)', () => {
    expect(lightEffects('bright', { truesightFt: 60 }, 30)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
  });

  it('truesight overrides dim light (no penalty within range)', () => {
    expect(lightEffects('dim', { truesightFt: 60 }, 30)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
  });

  it('truesight overrides darkness within range', () => {
    expect(lightEffects('darkness', { truesightFt: 120 }, 100)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
  });

  it('truesight out of range: falls back to darkvision/light rules', () => {
    expect(
      lightEffects('darkness', { truesightFt: 30, darkvisionFt: 60 }, 50),
    ).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
    });
  });

  it('truesight out of range, no darkvision, darkness: blinded', () => {
    expect(lightEffects('darkness', { truesightFt: 30 }, 50)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: true,
    });
  });

  it('darkvision exact-edge: distance === darkvisionFt counts as in range', () => {
    expect(lightEffects('dim', { darkvisionFt: 60 }, 60)).toEqual({
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
    });
    expect(lightEffects('darkness', { darkvisionFt: 60 }, 60)).toEqual({
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
    });
  });
});
