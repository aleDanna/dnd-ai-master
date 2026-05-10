import { describe, expect, it } from 'vitest';
import {
  BASTION_FORTIFICATIONS,
  BASTION_ROOM_KINDS,
  DOWNTIME_ACTIVITY_KINDS,
  buildDefaultBastion,
  defaultBastionRooms,
  defaultDefenders,
  downtimeRequirements,
  hirelingCostPerDay,
  hirelingTotalCost,
  isValidBastionFortification,
  isValidBastionRoomKind,
  isValidDowntimeActivityKind,
} from '@/engine/downtime';
import type { Bastion } from '@/engine/types';

describe('downtimeRequirements (PHB §6)', () => {
  it('practicing_profession → 5 days, no cost, no check', () => {
    expect(downtimeRequirements('practicing_profession')).toEqual({ daysRequired: 5 });
  });

  it('recuperating → 3 days + DC 15 CON save', () => {
    expect(downtimeRequirements('recuperating')).toEqual({
      daysRequired: 3,
      abilityCheck: { ability: 'CON', dc: 15 },
    });
  });

  it('researching → 1 day + DC 15 INT check', () => {
    expect(downtimeRequirements('researching')).toEqual({
      daysRequired: 1,
      abilityCheck: { ability: 'INT', dc: 15 },
    });
  });

  it('training → 250 days at 1 gp/day, no check', () => {
    expect(downtimeRequirements('training')).toEqual({
      daysRequired: 250,
      gpCostPerDay: 1,
    });
  });

  it('crafting → 0 days (routed through Phase 12)', () => {
    expect(downtimeRequirements('crafting')).toEqual({ daysRequired: 0 });
  });
});

describe('isValidDowntimeActivityKind', () => {
  it('accepts all known activity kinds', () => {
    for (const k of DOWNTIME_ACTIVITY_KINDS) {
      expect(isValidDowntimeActivityKind(k)).toBe(true);
    }
  });

  it('rejects unknown / non-string values', () => {
    expect(isValidDowntimeActivityKind('digging')).toBe(false);
    expect(isValidDowntimeActivityKind('')).toBe(false);
    expect(isValidDowntimeActivityKind(null)).toBe(false);
    expect(isValidDowntimeActivityKind(undefined)).toBe(false);
    expect(isValidDowntimeActivityKind(42)).toBe(false);
  });
});

describe('hirelingCostPerDay (PHB §6)', () => {
  it('skilled = 2 gp / 0 sp per day', () => {
    expect(hirelingCostPerDay('skilled')).toEqual({ goldPerDay: 2, silverPerDay: 0 });
  });

  it('unskilled = 0 gp / 2 sp per day', () => {
    expect(hirelingCostPerDay('unskilled')).toEqual({ goldPerDay: 0, silverPerDay: 2 });
  });
});

describe('hirelingTotalCost', () => {
  it('1 skilled × 1 day = 2 gp / 0 sp', () => {
    expect(hirelingTotalCost('skilled', 1, 1)).toEqual({ gp: 2, sp: 0 });
  });

  it('2 unskilled × 10 days = 0 gp / 40 sp', () => {
    expect(hirelingTotalCost('unskilled', 2, 10)).toEqual({ gp: 0, sp: 40 });
  });

  it('5 skilled × 30 days = 300 gp / 0 sp', () => {
    expect(hirelingTotalCost('skilled', 5, 30)).toEqual({ gp: 300, sp: 0 });
  });

  it('clamps negative count/days to zero', () => {
    expect(hirelingTotalCost('skilled', -3, 5)).toEqual({ gp: 0, sp: 0 });
    expect(hirelingTotalCost('unskilled', 4, -7)).toEqual({ gp: 0, sp: 0 });
  });

  it('coerces non-finite inputs to zero', () => {
    expect(hirelingTotalCost('skilled', Number.NaN, 5)).toEqual({ gp: 0, sp: 0 });
    expect(hirelingTotalCost('unskilled', 4, Number.POSITIVE_INFINITY)).toEqual({ gp: 0, sp: 0 });
  });

  it('floors fractional inputs (no half-day partial wages)', () => {
    expect(hirelingTotalCost('skilled', 2.7, 3.4)).toEqual({ gp: 2 * 2 * 3, sp: 0 });
  });
});

describe('defaultBastionRooms (2024 PHB simplified)', () => {
  it('modest tier → 2 default rooms (kitchen + storage)', () => {
    const rooms = defaultBastionRooms('modest');
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => r.kind)).toEqual(['kitchen', 'storage']);
    expect(rooms.every((r) => r.level === 1)).toBe(true);
  });

  it('fortified tier → 4 default rooms (+ armory + training)', () => {
    const rooms = defaultBastionRooms('fortified');
    expect(rooms).toHaveLength(4);
    expect(rooms.map((r) => r.kind)).toEqual(['kitchen', 'storage', 'armory', 'training']);
    expect(rooms.every((r) => r.level === 1)).toBe(true);
  });

  it('castle tier → 7 default rooms with bumped levels', () => {
    const rooms = defaultBastionRooms('castle');
    expect(rooms).toHaveLength(7);
    expect(rooms.map((r) => r.kind)).toEqual([
      'kitchen',
      'storage',
      'armory',
      'training',
      'library',
      'shrine',
      'guesthouse',
    ]);
    // Castle bumps the core 4 rooms to level 2; library/shrine/guesthouse stay at 1.
    expect(rooms.find((r) => r.kind === 'kitchen')?.level).toBe(2);
    expect(rooms.find((r) => r.kind === 'library')?.level).toBe(1);
  });
});

describe('defaultDefenders (2024 PHB simplified)', () => {
  it('modest = 2 defenders', () => {
    expect(defaultDefenders('modest')).toBe(2);
  });

  it('fortified = 8 defenders', () => {
    expect(defaultDefenders('fortified')).toBe(8);
  });

  it('castle = 30 defenders', () => {
    expect(defaultDefenders('castle')).toBe(30);
  });
});

describe('buildDefaultBastion', () => {
  it('returns a fully-formed Bastion record using the tier defaults', () => {
    const b: Bastion = buildDefaultBastion('Ravenhollow Manor', 'fortified');
    expect(b.name).toBe('Ravenhollow Manor');
    expect(b.fortification).toBe('fortified');
    expect(b.rooms).toEqual(defaultBastionRooms('fortified'));
    expect(b.defenders).toBe(8);
  });

  it('castle name + tier produces 7 rooms / 30 defenders', () => {
    const b = buildDefaultBastion('Stormcrown Keep', 'castle');
    expect(b.rooms).toHaveLength(7);
    expect(b.defenders).toBe(30);
  });
});

describe('isValidBastionFortification', () => {
  it('accepts all 3 tiers', () => {
    for (const f of BASTION_FORTIFICATIONS) {
      expect(isValidBastionFortification(f)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isValidBastionFortification('mansion')).toBe(false);
    expect(isValidBastionFortification('')).toBe(false);
    expect(isValidBastionFortification(undefined)).toBe(false);
  });
});

describe('isValidBastionRoomKind', () => {
  it('accepts all 10 listed kinds', () => {
    for (const k of BASTION_ROOM_KINDS) {
      expect(isValidBastionRoomKind(k)).toBe(true);
    }
  });

  it('rejects unknown room kinds', () => {
    expect(isValidBastionRoomKind('dungeon')).toBe(false);
    expect(isValidBastionRoomKind('forge')).toBe(false);
    expect(isValidBastionRoomKind(null)).toBe(false);
  });
});
