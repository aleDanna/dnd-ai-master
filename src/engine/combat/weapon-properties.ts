import type { WeaponSpec } from './attack';

/**
 * PHB §9.4 — generic property check. Returns false when the weapon has
 * no `properties` list (legacy WeaponSpec without properties is treated
 * as "no special properties").
 */
export function hasProperty(weapon: WeaponSpec, prop: string): boolean {
  return weapon.properties?.includes(prop) ?? false;
}

/** PHB §9.4 — reach: melee reach extends to 10ft instead of 5ft. */
export function isReach(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'reach');
}

/**
 * PHB §9.4 — loading: only one shot per action/bonus/reaction, no matter
 * how many attacks the actor is otherwise entitled to.
 */
export function isLoading(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'loading');
}

/**
 * PHB §9.4 — ammunition: each attack consumes 1 of weapon.ammoSlug from
 * the attacker's inventory.
 */
export function isAmmunition(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'ammunition');
}

/**
 * PHB §9.4 — light: required for the off-hand weapon when two-weapon
 * fighting (PHB §3.15).
 */
export function isLight(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'light');
}

/**
 * Maximum melee reach in feet for the weapon. 10ft for reach weapons,
 * otherwise the standard 5ft.
 */
export function meleeReachFor(weapon: WeaponSpec): number {
  return isReach(weapon) ? 10 : 5;
}
