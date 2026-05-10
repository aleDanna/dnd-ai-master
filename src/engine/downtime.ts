import type {
  Bastion,
  BastionFortification,
  BastionRoom,
  BastionRoomKind,
  DowntimeActivityKind,
} from './types';

/**
 * Pure downtime/hireling/bastion helpers (PHB §6 + 2024 PHB Bastion).
 *
 * The engine layer here is purely functional: given an activity kind it
 * returns the days/gp/check requirements; given a hireling kind/count/days
 * it returns the cost ledger; given a fortification tier it returns the
 * default room list and defender count.
 *
 * Helpers do NOT decide whether the PC can afford an activity or hire —
 * the tool layer narrates that decision; the engine just stamps the
 * activity / hireling / bastion on the character so the master can
 * reference it across turns.
 */

// ─── Downtime activities (PHB §6) ──────────────────────────────────────────

/**
 * Requirements for a downtime activity, as returned by
 * `downtimeRequirements`. `daysRequired` is the canonical PHB §6 default
 * (master may override at the tool layer); `gpCostPerDay` only applies to
 * activities with a flat per-day spend (training); `abilityCheck` is the
 * resolution check the master rolls when the activity ends.
 */
export interface DowntimeActivityRequirements {
  /** Calendar days the activity occupies. May be 0 for activities routed elsewhere (crafting). */
  daysRequired: number;
  /** Optional flat gp cost per day (training). */
  gpCostPerDay?: number;
  /** Optional resolution check when the activity completes. */
  abilityCheck?: { ability: 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'; dc: number };
}

/**
 * PHB §6 — defaults for the 5 downtime kinds the engine tracks. The
 * `crafting` value is intentionally a no-op (0 days) because actual
 * crafting projects route through Phase 12's `start_crafting` tool — the
 * `crafting` literal exists in the union for completeness so the master
 * can refer to it as a kind without the engine duplicating the
 * crafting-specific bookkeeping here.
 */
export function downtimeRequirements(activity: DowntimeActivityKind): DowntimeActivityRequirements {
  switch (activity) {
    case 'practicing_profession':
      // PHB §6: 1 workweek (5 days), no flat cost — earns lifestyle
      // expenses (or more, with a tool/skill check the master rolls).
      return { daysRequired: 5 };
    case 'recuperating':
      // PHB §6: 3 days, then DC 15 CON save to end one disease or poison.
      return { daysRequired: 3, abilityCheck: { ability: 'CON', dc: 15 } };
    case 'researching':
      // PHB §6: 1 day per piece of info, DC 15 INT (Investigation) by default.
      return { daysRequired: 1, abilityCheck: { ability: 'INT', dc: 15 } };
    case 'training':
      // PHB §6: 250 days at 1 gp/day to learn a language or tool proficiency.
      return { daysRequired: 250, gpCostPerDay: 1 };
    case 'crafting':
      // Routed through Phase 12 — the engine returns 0 days here so the
      // master can recognise the kind without double-counting.
      return { daysRequired: 0 };
  }
}

/** Validation set for `DowntimeActivityKind` — used by tool input guards. */
export const DOWNTIME_ACTIVITY_KINDS: ReadonlyArray<DowntimeActivityKind> = [
  'practicing_profession',
  'recuperating',
  'researching',
  'training',
  'crafting',
];

export function isValidDowntimeActivityKind(kind: unknown): kind is DowntimeActivityKind {
  return (
    typeof kind === 'string' &&
    (DOWNTIME_ACTIVITY_KINDS as readonly string[]).includes(kind)
  );
}

// ─── Hirelings (PHB §6) ────────────────────────────────────────────────────

export interface HirelingCost {
  /** Daily wage in gp (skilled hirelings — artisans, scribes, mercenaries). */
  goldPerDay: number;
  /** Daily wage in sp (unskilled hirelings — laborers, porters). */
  silverPerDay: number;
}

/**
 * PHB §6 hireling rates: skilled = 2 gp/day, unskilled = 2 sp/day. The
 * shape returns BOTH gp and sp so the tool layer can render either
 * coinage cleanly without needing to remember the rate.
 */
export function hirelingCostPerDay(kind: 'skilled' | 'unskilled'): HirelingCost {
  if (kind === 'skilled') return { goldPerDay: 2, silverPerDay: 0 };
  return { goldPerDay: 0, silverPerDay: 2 };
}

/**
 * Compute the total hireling cost for `count` hirelings of `kind` over
 * `days` days. Returns `{ gp, sp }` summed across the entire engagement.
 * Negative inputs are clamped to 0 so a malformed master call never
 * produces a negative ledger.
 */
export function hirelingTotalCost(
  kind: 'skilled' | 'unskilled',
  count: number,
  days: number,
): { gp: number; sp: number } {
  const safeCount = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const safeDays = Math.max(0, Math.floor(Number.isFinite(days) ? days : 0));
  const c = hirelingCostPerDay(kind);
  return {
    gp: c.goldPerDay * safeCount * safeDays,
    sp: c.silverPerDay * safeCount * safeDays,
  };
}

// ─── Bastion (2024 PHB simplified) ─────────────────────────────────────────

/**
 * Default room list for a fresh bastion at the given fortification tier.
 * The 2024 PHB Bastion rules give a different room budget per tier; the
 * engine supplies sensible PHB-aligned defaults so a master can call
 * `set_bastion` and immediately get a coherent starting structure.
 *
 *   - modest    → 2 rooms (kitchen + storage)
 *   - fortified → 4 rooms (above + armory + training)
 *   - castle    → 7 rooms (above with bumped levels + library/shrine/guesthouse)
 */
export function defaultBastionRooms(fortification: BastionFortification): BastionRoom[] {
  switch (fortification) {
    case 'modest':
      return [
        { kind: 'kitchen', level: 1 },
        { kind: 'storage', level: 1 },
      ];
    case 'fortified':
      return [
        { kind: 'kitchen', level: 1 },
        { kind: 'storage', level: 1 },
        { kind: 'armory', level: 1 },
        { kind: 'training', level: 1 },
      ];
    case 'castle':
      return [
        { kind: 'kitchen', level: 2 },
        { kind: 'storage', level: 2 },
        { kind: 'armory', level: 2 },
        { kind: 'training', level: 2 },
        { kind: 'library', level: 1 },
        { kind: 'shrine', level: 1 },
        { kind: 'guesthouse', level: 1 },
      ];
  }
}

/**
 * Default defender garrison size for the given fortification tier.
 * Defenders are non-PC NPCs the bastion employs — used narratively for
 * raids/sieges. The engine doesn't simulate their combat statlines.
 */
export function defaultDefenders(fortification: BastionFortification): number {
  switch (fortification) {
    case 'modest':
      return 2;
    case 'fortified':
      return 8;
    case 'castle':
      return 30;
  }
}

/**
 * Build a brand-new Bastion record using the per-tier defaults. Used by
 * `handleSetBastion` so the tool layer doesn't need to know the room
 * tables or defender counts. Callers can later mutate the result via
 * `add_bastion_room` or by overwriting with a fresh `set_bastion`.
 */
export function buildDefaultBastion(name: string, fortification: BastionFortification): Bastion {
  return {
    name,
    fortification,
    rooms: defaultBastionRooms(fortification),
    defenders: defaultDefenders(fortification),
  };
}

/** Validation set for `BastionFortification`. */
export const BASTION_FORTIFICATIONS: ReadonlyArray<BastionFortification> = [
  'modest',
  'fortified',
  'castle',
];

export function isValidBastionFortification(value: unknown): value is BastionFortification {
  return (
    typeof value === 'string' &&
    (BASTION_FORTIFICATIONS as readonly string[]).includes(value)
  );
}

/** Validation set for `BastionRoomKind`. */
export const BASTION_ROOM_KINDS: ReadonlyArray<BastionRoomKind> = [
  'workshop',
  'library',
  'armory',
  'stable',
  'garden',
  'storage',
  'training',
  'shrine',
  'kitchen',
  'guesthouse',
];

export function isValidBastionRoomKind(value: unknown): value is BastionRoomKind {
  return (
    typeof value === 'string' &&
    (BASTION_ROOM_KINDS as readonly string[]).includes(value)
  );
}
