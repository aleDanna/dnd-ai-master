import type { Size } from './types';

/**
 * Pure mounted-combat helpers (PHB §3.23).
 *
 * The engine layer here is purely functional: given a creature size pair,
 * return whether the larger creature may serve as a mount; given a rider's
 * speed, return the cost (in feet of movement) of mounting/dismounting.
 *
 * Helpers DO NOT decide whether the rider has movement budget left or
 * whether the mount is willing — the tool layer / master narrate those
 * decisions; the engine just stamps the mounted state on the rider.
 */

/**
 * Creature size ladder (PHB §1, monster manual sizing). Ordered smallest →
 * largest so `sizeRank` returns a comparable integer.
 */
const SIZE_ORDER: readonly Size[] = [
  'tiny',
  'small',
  'medium',
  'large',
  'huge',
  'gargantuan',
];

/**
 * Index of a `Size` along the canonical ladder. `tiny=0`, `small=1`, ...,
 * `gargantuan=5`. Returns -1 for unknown values (so callers can detect
 * malformed input defensively).
 */
export function sizeRank(size: Size): number {
  return SIZE_ORDER.indexOf(size);
}

/**
 * PHB §3.23 — a willing creature at least one size larger than the rider
 * may serve as a mount. Same-size or smaller creatures cannot. Returns
 * `false` when either size is unknown (defensive — the tool layer should
 * still treat this as "size data missing" and let the master decide).
 */
export function canBeMount(rider: Size, mount: Size): boolean {
  const r = sizeRank(rider);
  const m = sizeRank(mount);
  if (r < 0 || m < 0) return false;
  return m > r;
}

/**
 * PHB §3.23 — mounting or dismounting a creature costs an amount of
 * movement equal to half the rider's speed (rounded up). The engine
 * exposes this as a helper so the master can narratively show the cost
 * (e.g. "you spend 15 ft of your 30 ft speed climbing into the saddle").
 *
 * Negative or NaN inputs clamp to 0; the result is always a non-negative
 * integer.
 */
export function mountDismountCost(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.ceil(speed / 2);
}

/**
 * PHB §3.23 — when a mount is in `controlled` mode, it acts on the
 * rider's initiative count and may only take the Dash, Disengage, or
 * Dodge action (the rider directs everything else). An `independent`
 * mount uses its own initiative and chooses its own actions.
 */
export const CONTROLLED_MOUNT_ALLOWED_ACTIONS = [
  'dash',
  'disengage',
  'dodge',
] as const;

/**
 * Set of valid `MountMode` values, kept in this module so the tool-layer
 * input validators can use it without re-deriving it.
 */
export const MOUNT_MODES = ['controlled', 'independent'] as const;

export function isValidMountMode(value: unknown): value is 'controlled' | 'independent' {
  return typeof value === 'string' && (MOUNT_MODES as readonly string[]).includes(value);
}

/**
 * Set of valid `Size` values, kept here so the tool layer / hydrators can
 * sanity-check input without re-deriving it.
 */
export const SIZES: readonly Size[] = SIZE_ORDER;

export function isValidSize(value: unknown): value is Size {
  return typeof value === 'string' && (SIZES as readonly string[]).includes(value);
}
