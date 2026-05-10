import { describe, expect, it } from 'vitest';
import {
  actionSurgeUses,
  bardicInspirationDie,
  bardicInspirationUses,
  channelDivinityUses,
  classLevel,
  layOnHandsPool,
  rageDamageBonus,
  rageUsesPerDay,
  sneakAttackDice,
} from '@/engine/class-features';
import type { Character } from '@/engine/types';

function pc(opts: Partial<Character> & Pick<Character, 'classes' | 'classSlug' | 'level'>): Character {
  return {
    id: 'pc1',
    name: 'Test',
    xp: 0,
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: 2,
    hpMax: 10,
    ac: 10,
    speed: 30,
    proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 1,
    hitDieSize: 8,
    ...opts,
  };
}

describe('class-features helpers', () => {
  describe('sneakAttackDice', () => {
    it('returns 0 for level <= 0', () => {
      expect(sneakAttackDice(0)).toBe(0);
      expect(sneakAttackDice(-3)).toBe(0);
    });
    it('rounds up: 1->1, 2->1, 3->2, 4->2, 5->3, 11->6, 20->10', () => {
      expect(sneakAttackDice(1)).toBe(1);
      expect(sneakAttackDice(2)).toBe(1);
      expect(sneakAttackDice(3)).toBe(2);
      expect(sneakAttackDice(4)).toBe(2);
      expect(sneakAttackDice(5)).toBe(3);
      expect(sneakAttackDice(11)).toBe(6);
      expect(sneakAttackDice(20)).toBe(10);
    });
  });

  describe('rageDamageBonus', () => {
    it('zero for level <= 0', () => {
      expect(rageDamageBonus(0)).toBe(0);
    });
    it('+2 at L1-8', () => {
      expect(rageDamageBonus(1)).toBe(2);
      expect(rageDamageBonus(8)).toBe(2);
    });
    it('+3 at L9-15', () => {
      expect(rageDamageBonus(9)).toBe(3);
      expect(rageDamageBonus(15)).toBe(3);
    });
    it('+4 at L16+', () => {
      expect(rageDamageBonus(16)).toBe(4);
      expect(rageDamageBonus(20)).toBe(4);
    });
  });

  describe('rageUsesPerDay', () => {
    it('zero for level <= 0', () => {
      expect(rageUsesPerDay(0)).toBe(0);
    });
    it('progresses 2/3/4/5/Infinity at the right breakpoints', () => {
      expect(rageUsesPerDay(1)).toBe(2);
      expect(rageUsesPerDay(2)).toBe(2);
      expect(rageUsesPerDay(3)).toBe(3);
      expect(rageUsesPerDay(5)).toBe(3);
      expect(rageUsesPerDay(6)).toBe(4);
      expect(rageUsesPerDay(11)).toBe(4);
      expect(rageUsesPerDay(12)).toBe(5);
      expect(rageUsesPerDay(16)).toBe(5);
      expect(rageUsesPerDay(17)).toBe(Infinity);
      expect(rageUsesPerDay(20)).toBe(Infinity);
    });
  });

  describe('actionSurgeUses', () => {
    it('zero at L1, one at L2-16, two at L17+', () => {
      expect(actionSurgeUses(1)).toBe(0);
      expect(actionSurgeUses(2)).toBe(1);
      expect(actionSurgeUses(16)).toBe(1);
      expect(actionSurgeUses(17)).toBe(2);
      expect(actionSurgeUses(20)).toBe(2);
    });
  });

  describe('channelDivinityUses', () => {
    it('cleric breakpoints', () => {
      expect(channelDivinityUses(1, 'cleric')).toBe(0);
      expect(channelDivinityUses(2, 'cleric')).toBe(1);
      expect(channelDivinityUses(5, 'cleric')).toBe(1);
      expect(channelDivinityUses(6, 'cleric')).toBe(2);
      expect(channelDivinityUses(17, 'cleric')).toBe(2);
      expect(channelDivinityUses(18, 'cleric')).toBe(3);
      expect(channelDivinityUses(20, 'cleric')).toBe(3);
    });
    it('paladin breakpoints', () => {
      expect(channelDivinityUses(1, 'paladin')).toBe(0);
      expect(channelDivinityUses(2, 'paladin')).toBe(0);
      expect(channelDivinityUses(3, 'paladin')).toBe(1);
      expect(channelDivinityUses(20, 'paladin')).toBe(1);
    });
    it('zero for level <= 0', () => {
      expect(channelDivinityUses(0, 'cleric')).toBe(0);
      expect(channelDivinityUses(0, 'paladin')).toBe(0);
    });
  });

  describe('bardicInspirationDie', () => {
    it('d6 L1-4, d8 L5-9, d10 L10-14, d12 L15+', () => {
      expect(bardicInspirationDie(1)).toBe(6);
      expect(bardicInspirationDie(4)).toBe(6);
      expect(bardicInspirationDie(5)).toBe(8);
      expect(bardicInspirationDie(9)).toBe(8);
      expect(bardicInspirationDie(10)).toBe(10);
      expect(bardicInspirationDie(14)).toBe(10);
      expect(bardicInspirationDie(15)).toBe(12);
      expect(bardicInspirationDie(20)).toBe(12);
    });
  });

  describe('bardicInspirationUses', () => {
    it('zero for non-bards', () => {
      expect(bardicInspirationUses(0, 3)).toBe(0);
    });
    it('= max(1, chaMod) for bards', () => {
      expect(bardicInspirationUses(1, -1)).toBe(1); // floor at 1
      expect(bardicInspirationUses(1, 0)).toBe(1);
      expect(bardicInspirationUses(5, 3)).toBe(3);
      expect(bardicInspirationUses(20, 5)).toBe(5);
    });
  });

  describe('layOnHandsPool', () => {
    it('5 * paladin level', () => {
      expect(layOnHandsPool(0)).toBe(0);
      expect(layOnHandsPool(1)).toBe(5);
      expect(layOnHandsPool(5)).toBe(25);
      expect(layOnHandsPool(20)).toBe(100);
    });
  });

  describe('classLevel (multi-class lookup)', () => {
    it('returns 0 when the PC has no levels in the class', () => {
      const c = pc({
        classSlug: 'fighter',
        level: 5,
        classes: [{ slug: 'fighter', level: 5 }],
      });
      expect(classLevel(c, 'rogue')).toBe(0);
    });
    it('returns the per-class level for a multi-class PC', () => {
      const c = pc({
        classSlug: 'fighter',
        level: 6,
        classes: [
          { slug: 'fighter', level: 4 },
          { slug: 'rogue', level: 2 },
        ],
      });
      expect(classLevel(c, 'fighter')).toBe(4);
      expect(classLevel(c, 'rogue')).toBe(2);
      expect(classLevel(c, 'wizard')).toBe(0);
    });
    it('falls back to classSlug+level when classes is missing', () => {
      const c = pc({
        classSlug: 'barbarian',
        level: 7,
      });
      // No classes array — legacy path.
      expect(classLevel(c, 'barbarian')).toBe(7);
      expect(classLevel(c, 'fighter')).toBe(0);
    });
    it('is case-insensitive on slug', () => {
      const c = pc({
        classSlug: 'fighter',
        level: 3,
        classes: [{ slug: 'fighter', level: 3 }],
      });
      expect(classLevel(c, 'FIGHTER')).toBe(3);
      expect(classLevel(c, 'Fighter')).toBe(3);
    });
  });
});
