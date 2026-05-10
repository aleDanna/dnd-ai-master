import { describe, expect, it } from 'vitest';
import {
  VEHICLE_CATALOG,
  VEHICLE_SLUGS,
  isValidVehicleSlug,
  mountTripSpeed,
  vehicleBySlug,
} from '@/engine/vehicles';

describe('VEHICLE_CATALOG (PHB §9.6 + DMG)', () => {
  it('contains the 10 expected slugs', () => {
    expect(Object.keys(VEHICLE_CATALOG).sort()).toEqual(
      [
        'airship',
        'carriage',
        'cart',
        'galley',
        'longship',
        'rowboat',
        'sailing-ship',
        'sled',
        'wagon',
        'warship',
      ].sort(),
    );
  });

  it('every entry has a stable slug matching its key', () => {
    for (const [k, v] of Object.entries(VEHICLE_CATALOG)) {
      expect(v.slug).toBe(k);
      expect(typeof v.name).toBe('string');
      expect(v.name.length).toBeGreaterThan(0);
    }
  });

  it('cart matches PHB §9.6 (15 gp, 2 pax, 200 lb)', () => {
    const c = VEHICLE_CATALOG.cart;
    expect(c.costGp).toBe(15);
    expect(c.passengers).toBe(2);
    expect(c.capacityLb).toBe(200);
    expect(c.speedFt).toBe(0); // ground vehicles depend on draft animal
  });

  it('sailing-ship matches DMG (15 AC, 300 HP, 15 dmg threshold, 20 crew)', () => {
    const s = VEHICLE_CATALOG['sailing-ship'];
    expect(s.ac).toBe(15);
    expect(s.hpMax).toBe(300);
    expect(s.damageThreshold).toBe(15);
    expect(s.crew).toBe(20);
    expect(s.passengers).toBe(20);
  });

  it('galley is the fastest water vessel (400 ft) and most expensive (30000 gp)', () => {
    const galley = VEHICLE_CATALOG.galley;
    expect(galley.speedFt).toBe(400);
    expect(galley.costGp).toBe(30_000);
    expect(galley.crew).toBe(80);
  });

  it('airship has flight stats (80 ft, 13 AC, 10 dmg threshold)', () => {
    const a = VEHICLE_CATALOG.airship;
    expect(a.speedFt).toBe(80);
    expect(a.ac).toBe(13);
    expect(a.damageThreshold).toBe(10);
    expect(a.crew).toBe(10);
  });

  it('rowboat is small, cheap (50 gp), 1-crew', () => {
    const r = VEHICLE_CATALOG.rowboat;
    expect(r.costGp).toBe(50);
    expect(r.crew).toBe(1);
    expect(r.hpMax).toBe(50);
  });
});

describe('vehicleBySlug', () => {
  it('returns the entry for a known slug', () => {
    expect(vehicleBySlug('rowboat')).toMatchObject({ slug: 'rowboat', costGp: 50 });
  });

  it('returns undefined for an unknown slug', () => {
    expect(vehicleBySlug('mecha')).toBeUndefined();
    expect(vehicleBySlug('')).toBeUndefined();
  });
});

describe('mountTripSpeed (PHB §3.23)', () => {
  it('doubles a 60 ft mount speed for the one-hour gallop rule', () => {
    expect(mountTripSpeed(60)).toBe(120);
  });

  it('returns 0 for negative / NaN / 0 inputs', () => {
    expect(mountTripSpeed(0)).toBe(0);
    expect(mountTripSpeed(-1)).toBe(0);
    expect(mountTripSpeed(Number.NaN)).toBe(0);
  });
});

describe('isValidVehicleSlug / VEHICLE_SLUGS', () => {
  it('accepts every catalogued slug', () => {
    for (const s of VEHICLE_SLUGS) expect(isValidVehicleSlug(s)).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isValidVehicleSlug('hovercraft')).toBe(false);
    expect(isValidVehicleSlug(42)).toBe(false);
    expect(isValidVehicleSlug(null)).toBe(false);
  });
});
