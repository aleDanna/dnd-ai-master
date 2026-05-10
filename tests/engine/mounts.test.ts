import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_MOUNT_ALLOWED_ACTIONS,
  MOUNT_MODES,
  SIZES,
  canBeMount,
  isValidMountMode,
  isValidSize,
  mountDismountCost,
  sizeRank,
} from '@/engine/mounts';
import type { Size } from '@/engine/types';

describe('sizeRank (PHB §1)', () => {
  it('returns 0..5 for each size from tiny to gargantuan', () => {
    expect(sizeRank('tiny')).toBe(0);
    expect(sizeRank('small')).toBe(1);
    expect(sizeRank('medium')).toBe(2);
    expect(sizeRank('large')).toBe(3);
    expect(sizeRank('huge')).toBe(4);
    expect(sizeRank('gargantuan')).toBe(5);
  });

  it('returns -1 for an unknown size value', () => {
    expect(sizeRank('colossal' as Size)).toBe(-1);
  });
});

describe('canBeMount (PHB §3.23)', () => {
  it('medium rider on large mount is legal', () => {
    expect(canBeMount('medium', 'large')).toBe(true);
  });

  it('small rider on medium mount is legal (one size larger)', () => {
    expect(canBeMount('small', 'medium')).toBe(true);
  });

  it('medium rider on huge mount is legal (two sizes larger)', () => {
    expect(canBeMount('medium', 'huge')).toBe(true);
  });

  it('same-size rider+mount is NOT legal', () => {
    expect(canBeMount('medium', 'medium')).toBe(false);
  });

  it('rider larger than mount is NOT legal', () => {
    expect(canBeMount('large', 'medium')).toBe(false);
  });

  it('tiny on small is legal (one size larger)', () => {
    expect(canBeMount('tiny', 'small')).toBe(true);
  });

  it('huge on gargantuan is legal', () => {
    expect(canBeMount('huge', 'gargantuan')).toBe(true);
  });

  it('returns false when either size is unknown', () => {
    expect(canBeMount('medium', 'colossal' as Size)).toBe(false);
    expect(canBeMount('colossal' as Size, 'large')).toBe(false);
  });
});

describe('mountDismountCost (PHB §3.23)', () => {
  it('30 ft speed → 15 ft cost', () => {
    expect(mountDismountCost(30)).toBe(15);
  });

  it('25 ft speed → 13 ft cost (rounded up)', () => {
    expect(mountDismountCost(25)).toBe(13);
  });

  it('40 ft speed → 20 ft cost', () => {
    expect(mountDismountCost(40)).toBe(20);
  });

  it('0 / negative / NaN speed clamps to 0 ft cost', () => {
    expect(mountDismountCost(0)).toBe(0);
    expect(mountDismountCost(-10)).toBe(0);
    expect(mountDismountCost(Number.NaN)).toBe(0);
  });
});

describe('CONTROLLED_MOUNT_ALLOWED_ACTIONS (PHB §3.23)', () => {
  it('contains exactly Dash, Disengage, and Dodge', () => {
    expect([...CONTROLLED_MOUNT_ALLOWED_ACTIONS].sort()).toEqual([
      'dash',
      'disengage',
      'dodge',
    ]);
  });
});

describe('isValidMountMode / MOUNT_MODES', () => {
  it('accepts controlled and independent', () => {
    expect(isValidMountMode('controlled')).toBe(true);
    expect(isValidMountMode('independent')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isValidMountMode('berserk')).toBe(false);
    expect(isValidMountMode(42)).toBe(false);
    expect(isValidMountMode(null)).toBe(false);
  });

  it('MOUNT_MODES is the matching tuple', () => {
    expect(MOUNT_MODES).toEqual(['controlled', 'independent']);
  });
});

describe('isValidSize / SIZES', () => {
  it('accepts all six canonical sizes', () => {
    for (const s of SIZES) expect(isValidSize(s)).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isValidSize('colossal')).toBe(false);
    expect(isValidSize(0)).toBe(false);
  });
});
