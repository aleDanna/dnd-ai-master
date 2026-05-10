import { describe, it, expect } from 'vitest';
import {
  hasProperty,
  isReach,
  isLoading,
  isAmmunition,
  isLight,
  meleeReachFor,
} from '@/engine/combat/weapon-properties';
import type { WeaponSpec } from '@/engine/combat/attack';

const longsword: WeaponSpec = {
  name: 'Longsword',
  damage: '1d8',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['versatile'],
};

const halberd: WeaponSpec = {
  name: 'Halberd',
  damage: '1d10',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['heavy', 'reach', 'two-handed'],
};

const lightCrossbow: WeaponSpec = {
  name: 'Light Crossbow',
  damage: '1d8',
  damageType: 'piercing',
  profGroup: 'Simple',
  useDex: true,
  properties: ['ammunition', 'loading', 'two-handed'],
  ammoSlug: 'crossbow-bolt',
  range: { normal: 80, long: 320 },
};

const dagger: WeaponSpec = {
  name: 'Dagger',
  damage: '1d4',
  damageType: 'piercing',
  profGroup: 'Simple',
  useDex: true,
  properties: ['finesse', 'light', 'thrown'],
  range: { normal: 20, long: 60 },
};

const legacyNoProps: WeaponSpec = {
  name: 'Club',
  damage: '1d4',
  damageType: 'bludgeoning',
  profGroup: 'Simple',
  useDex: false,
};

describe('weapon-properties helpers (PHB §9.4)', () => {
  describe('hasProperty', () => {
    it('returns true when listed', () => {
      expect(hasProperty(halberd, 'reach')).toBe(true);
    });
    it('returns false when missing', () => {
      expect(hasProperty(longsword, 'reach')).toBe(false);
    });
    it('returns false when properties undefined (legacy weapon)', () => {
      expect(hasProperty(legacyNoProps, 'light')).toBe(false);
    });
  });

  describe('isReach', () => {
    it('false for longsword (versatile only)', () => {
      expect(isReach(longsword)).toBe(false);
    });
    it('true for halberd', () => {
      expect(isReach(halberd)).toBe(true);
    });
  });

  describe('meleeReachFor', () => {
    it('returns 5 for non-reach weapons', () => {
      expect(meleeReachFor(longsword)).toBe(5);
      expect(meleeReachFor(legacyNoProps)).toBe(5);
    });
    it('returns 10 for reach weapons', () => {
      expect(meleeReachFor(halberd)).toBe(10);
    });
  });

  describe('isLoading', () => {
    it('true for light crossbow', () => {
      expect(isLoading(lightCrossbow)).toBe(true);
    });
    it('false for longsword', () => {
      expect(isLoading(longsword)).toBe(false);
    });
  });

  describe('isLight', () => {
    it('true for dagger', () => {
      expect(isLight(dagger)).toBe(true);
    });
    it('false for longsword', () => {
      expect(isLight(longsword)).toBe(false);
    });
  });

  describe('isAmmunition', () => {
    it('true for light crossbow with ammoSlug', () => {
      expect(isAmmunition(lightCrossbow)).toBe(true);
      expect(lightCrossbow.ammoSlug).toBe('crossbow-bolt');
    });
    it('false for daggers (thrown but not ammunition)', () => {
      expect(isAmmunition(dagger)).toBe(false);
    });
  });
});
