/**
 * Vehicle catalog (PHB §9.6 mundane gear + DMG / Ghosts of Saltmarsh ships).
 *
 * The catalog is read-only: the master cannot mutate the vehicle definitions
 * themselves; it can only embark/disembark a PC on a vehicle. Stats follow
 * the published rules (speed in feet per round of in-combat travel, capacity
 * in pounds, gp prices, AC/HP/damage threshold/crew when the vehicle is
 * combat-relevant).
 *
 * Ground vehicles (cart, sled, wagon, carriage) carry a 0 ft `speedFt` —
 * their speed in combat is governed by the draft animal pulling them, not
 * the vehicle itself. Ships (rowboat, sailing-ship, galley, longship,
 * warship) carry their nominal speed-per-hour-in-feet shorthand from the
 * published tables.
 */

export interface Vehicle {
  /** Stable lookup key (slug-cased). */
  slug: string;
  /** Display name in proper case. */
  name: string;
  /**
   * Speed in feet per round (or per hour shorthand for ships, mirroring
   * the published tables). 0 for vehicles whose speed depends on the
   * draft animal pulling them (cart/wagon/carriage/sled).
   */
  speedFt: number;
  /** Cargo capacity in pounds (0 if the vehicle carries no cargo). */
  capacityLb: number;
  /** Maximum number of passengers (excluding crew). */
  passengers: number;
  /** Purchase price in gold pieces (PHB §9.6 / DMG ship pricing). */
  costGp: number;
  /** Optional armor class — present for combat-relevant vehicles. */
  ac?: number;
  /** Optional max HP — present for combat-relevant vehicles. */
  hpMax?: number;
  /** Optional damage threshold (DMG ship rules) — attacks below it deal 0 damage. */
  damageThreshold?: number;
  /** Required crew complement (operating crew, not passengers). */
  crew?: number;
}

/**
 * Catalog of supported vehicles. Stats follow the PHB §9.6 mundane vehicle
 * table for ground vehicles and the DMG ship rules (further popularised by
 * Ghosts of Saltmarsh) for water/air vessels.
 *
 *   - **Ground**: cart, sled, wagon, carriage — speed/AC depend on the draft
 *     animal; the catalog stores 0 ft speed and no AC/HP.
 *   - **Water**: rowboat, sailing-ship, galley, longship, warship — full
 *     combat-relevant stats including AC, HP, and damage threshold.
 *   - **Air**: airship — flying vessel, slower than the fast ships but
 *     unrestricted by terrain.
 */
export const VEHICLE_CATALOG: Record<string, Vehicle> = {
  // ── PHB §9.6 mundane vehicles ──
  cart: {
    slug: 'cart',
    name: 'Cart',
    speedFt: 0,
    capacityLb: 200,
    passengers: 2,
    costGp: 15,
  },
  sled: {
    slug: 'sled',
    name: 'Sled',
    speedFt: 0,
    capacityLb: 100,
    passengers: 1,
    costGp: 20,
  },
  wagon: {
    slug: 'wagon',
    name: 'Wagon',
    speedFt: 0,
    capacityLb: 2000,
    passengers: 4,
    costGp: 35,
  },
  carriage: {
    slug: 'carriage',
    name: 'Carriage',
    speedFt: 0,
    capacityLb: 0,
    passengers: 4,
    costGp: 100,
  },
  // ── DMG / Ghosts of Saltmarsh ships (simplified) ──
  rowboat: {
    slug: 'rowboat',
    name: 'Rowboat',
    speedFt: 150,
    capacityLb: 1000,
    passengers: 4,
    costGp: 50,
    ac: 11,
    hpMax: 50,
    crew: 1,
  },
  'sailing-ship': {
    slug: 'sailing-ship',
    name: 'Sailing Ship',
    speedFt: 200,
    capacityLb: 100_000,
    passengers: 20,
    costGp: 10_000,
    ac: 15,
    hpMax: 300,
    damageThreshold: 15,
    crew: 20,
  },
  galley: {
    slug: 'galley',
    name: 'Galley',
    speedFt: 400,
    capacityLb: 150_000,
    passengers: 80,
    costGp: 30_000,
    ac: 15,
    hpMax: 500,
    damageThreshold: 20,
    crew: 80,
  },
  longship: {
    slug: 'longship',
    name: 'Longship',
    speedFt: 300,
    capacityLb: 50_000,
    passengers: 40,
    costGp: 10_000,
    ac: 15,
    hpMax: 300,
    damageThreshold: 15,
    crew: 40,
  },
  warship: {
    slug: 'warship',
    name: 'Warship',
    speedFt: 250,
    capacityLb: 200_000,
    passengers: 60,
    costGp: 25_000,
    ac: 15,
    hpMax: 500,
    damageThreshold: 20,
    crew: 60,
  },
  airship: {
    slug: 'airship',
    name: 'Airship',
    speedFt: 80,
    capacityLb: 5000,
    passengers: 20,
    costGp: 20_000,
    ac: 13,
    hpMax: 300,
    damageThreshold: 10,
    crew: 10,
  },
};

/**
 * Lookup helper: returns the `Vehicle` record for a given slug, or
 * `undefined` if the slug is not in the catalog. Callers should treat
 * `undefined` as "unknown vehicle" and surface an error to the master.
 */
export function vehicleBySlug(slug: string): Vehicle | undefined {
  return VEHICLE_CATALOG[slug];
}

/**
 * PHB §3.23 — a mount can travel for one hour at twice its base land
 * speed before tiring (rule used to size single-trip travel). Returns
 * the doubled speed clamped at 0.
 */
export function mountTripSpeed(baseSpeedFt: number): number {
  if (!Number.isFinite(baseSpeedFt) || baseSpeedFt <= 0) return 0;
  return baseSpeedFt * 2;
}

/** Validation set for the catalog slugs — used by tool input guards. */
export const VEHICLE_SLUGS: readonly string[] = Object.keys(VEHICLE_CATALOG);

export function isValidVehicleSlug(value: unknown): value is string {
  return typeof value === 'string' && VEHICLE_SLUGS.includes(value);
}
