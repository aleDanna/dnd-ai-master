/**
 * Phase 11 — pure helpers for the 6 PHB class features the engine resolves
 * directly: Sneak Attack (Rogue), Rage (Barbarian), Action Surge (Fighter),
 * Channel Divinity (Cleric/Paladin), Bardic Inspiration (Bard), Lay on Hands
 * (Paladin).
 *
 * Each helper is a pure function over level inputs (and CHA mod for Bardic
 * Inspiration). Tool handlers and combat integration sit on top of these
 * helpers so the level breakpoints stay verifiable in isolation.
 *
 * Multi-class lookup helper `classLevel(character, classSlug)` sums the
 * `Character.classes` entries that match the slug — the engine treats the
 * level used for these features as the per-class subtotal, not the PC's
 * total level (PHB §2.5: "use only the relevant class's level").
 */

import type { Character } from './types';

/**
 * PHB §2.5 — total level the PC has in a specific class. Sums every entry
 * in `Character.classes` whose slug matches; falls back to the legacy
 * `classSlug` + `level` columns when the breakdown is missing.
 *
 * Returns 0 when the PC has no levels in the class.
 */
export function classLevel(character: Character, classSlug: string): number {
  const slug = classSlug.toLowerCase();
  if (Array.isArray(character.classes) && character.classes.length > 0) {
    return character.classes
      .filter((cl) => cl.slug.toLowerCase() === slug)
      .reduce((sum, cl) => sum + Math.max(0, Math.floor(cl.level)), 0);
  }
  // Legacy snapshot — only the starting class has a level.
  if (character.classSlug.toLowerCase() === slug) {
    return Math.max(0, Math.floor(character.level));
  }
  return 0;
}

/**
 * PHB Rogue: Sneak Attack damage = `ceil(rogueLevel / 2)` d6. Returns 0 when
 * the PC has no rogue levels (no sneak attack dice are rolled).
 */
export function sneakAttackDice(rogueLevel: number): number {
  if (rogueLevel <= 0) return 0;
  return Math.ceil(rogueLevel / 2);
}

/**
 * PHB Barbarian: Rage damage bonus by barbarian level.
 *   L1-8  → +2
 *   L9-15 → +3
 *   L16+  → +4
 * Returns 0 for non-barbarians (level <= 0) so callers can blindly add the
 * result to damage without an extra branch.
 */
export function rageDamageBonus(barbLevel: number): number {
  if (barbLevel <= 0) return 0;
  if (barbLevel >= 16) return 4;
  if (barbLevel >= 9) return 3;
  return 2;
}

/**
 * PHB Barbarian: Rage uses per long rest by barbarian level.
 *   L1-2  → 2
 *   L3-5  → 3
 *   L6-11 → 4
 *   L12-16 → 5
 *   L17+  → Infinity (unlimited)
 * Returns 0 for level <= 0 (no rage feature yet).
 */
export function rageUsesPerDay(barbLevel: number): number {
  if (barbLevel <= 0) return 0;
  if (barbLevel >= 17) return Infinity;
  if (barbLevel >= 12) return 5;
  if (barbLevel >= 6) return 4;
  if (barbLevel >= 3) return 3;
  return 2;
}

/**
 * PHB Fighter: Action Surge uses per short/long rest by fighter level.
 *   L1    → 0 (feature not yet gained)
 *   L2-16 → 1
 *   L17+  → 2
 */
export function actionSurgeUses(fighterLevel: number): number {
  if (fighterLevel <= 1) return 0;
  if (fighterLevel >= 17) return 2;
  return 1;
}

/**
 * PHB Cleric/Paladin: Channel Divinity uses per rest.
 *
 * Cleric (per short rest):
 *   L1    → 0
 *   L2-5  → 1
 *   L6-17 → 2
 *   L18+  → 3
 *
 * Paladin (per short rest at L11+, long rest L3-10):
 *   L1-2  → 0
 *   L3+   → 1
 *
 * Returns 0 for any other class slug (the feature isn't available).
 */
export function channelDivinityUses(level: number, classSlug: 'cleric' | 'paladin'): number {
  if (level <= 0) return 0;
  if (classSlug === 'cleric') {
    if (level >= 18) return 3;
    if (level >= 6) return 2;
    return level >= 2 ? 1 : 0;
  }
  // paladin
  return level >= 3 ? 1 : 0;
}

/**
 * PHB Bard: Bardic Inspiration die size by bard level.
 *   L1-4  → d6
 *   L5-9  → d8
 *   L10-14 → d10
 *   L15+  → d12
 *
 * Returns d6 by default for level <= 0 — callers should still gate on the
 * bard having the feature; the die size itself is well-defined down to L0
 * for the engine.
 */
export function bardicInspirationDie(bardLevel: number): 6 | 8 | 10 | 12 {
  if (bardLevel >= 15) return 12;
  if (bardLevel >= 10) return 10;
  if (bardLevel >= 5) return 8;
  return 6;
}

/**
 * PHB Bard: Bardic Inspiration uses per rest = max(1, CHA modifier).
 * Recharges on long rest L1-4, short rest L5+. Returns 0 for level <= 0
 * (the feature isn't available); otherwise at least 1 use is granted even
 * with a negative CHA modifier (PHB minimum).
 */
export function bardicInspirationUses(bardLevel: number, chaMod: number): number {
  if (bardLevel <= 0) return 0;
  return Math.max(1, chaMod);
}

/**
 * PHB Paladin: Lay on Hands pool = `paladinLevel * 5` HP per long rest.
 * Returns 0 for level <= 0.
 */
export function layOnHandsPool(paladinLevel: number): number {
  if (paladinLevel <= 0) return 0;
  return paladinLevel * 5;
}
