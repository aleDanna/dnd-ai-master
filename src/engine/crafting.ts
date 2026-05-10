import type { CraftingKind, Rarity } from './types';

/**
 * Pure crafting helpers (PHB §5 + DMG crafting rules).
 *
 * The engine layer here is purely functional: given an item kind and the
 * relevant inputs (price for non-magical items, rarity for magic items,
 * spell level for scrolls/potions) it returns the days/gp requirements.
 *
 * Helpers DO NOT decide whether the PC can afford the project. The tool
 * layer narrates that — the engine just stamps the project on the
 * character so progress can be tracked across long-rest cycles.
 */

export interface CraftingRequirements {
  /** Calendar days of work required to finish the project. Always ≥ 1. */
  daysRequired: number;
  /** Gold-piece cost of the materials/ingredients. Always ≥ 0. */
  gpRequired: number;
}

/** Subset of `Rarity` that DMG crafting rules support. Artifacts are
 *  pointedly NOT craftable — they are unique. */
export type CraftableRarity = Exclude<Rarity, 'artifact'>;

/** Spell levels covered by the scroll/potion crafting helpers. */
export type CraftingSpellLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * PHB §5: non-magical crafting. The PC works at a rate of 5 sp per day
 * (= 0.5 gp/day) of progress on the item's list price; total ingredient
 * cost is half the price. So an item priced at P gp:
 *
 *   - daysRequired = ceil(P_in_sp / 5sp_per_day) = ceil(P × 10 / 5) = ceil(2P)
 *   - gpRequired   = ceil(P / 2)
 *
 * `ceil` is used so a 7 gp item still rounds up to 14 days / 4 gp
 * (instead of silently dropping fractional progress). Days are clamped
 * at a minimum of 1 — an item priced at 0 gp still takes a full day to
 * fashion narratively (e.g. simple gear).
 */
export function nonMagicalCraftingRequirements(itemPriceGp: number): CraftingRequirements {
  const safe = Math.max(0, Number.isFinite(itemPriceGp) ? itemPriceGp : 0);
  const daysRequired = Math.max(1, Math.ceil(safe * 2));
  const gpRequired = Math.max(0, Math.ceil(safe / 2));
  return { daysRequired, gpRequired };
}

/**
 * DMG: magic-item crafting tiers. Each tier of rarity defines a fixed
 * (days, gp) pair from the DMG's "Crafting Magic Items" table. Artifacts
 * are not craftable and intentionally fall outside this enum.
 */
export function magicItemCraftingRequirements(rarity: CraftableRarity): CraftingRequirements {
  switch (rarity) {
    case 'common':
      return { daysRequired: 4, gpRequired: 50 };
    case 'uncommon':
      return { daysRequired: 20, gpRequired: 200 };
    case 'rare':
      return { daysRequired: 100, gpRequired: 2_000 };
    case 'very_rare':
      return { daysRequired: 500, gpRequired: 20_000 };
    case 'legendary':
      return { daysRequired: 2500, gpRequired: 100_000 };
  }
}

/**
 * PHB §11 / Xanathar's: scroll crafting (a wizard / scribe transcribes a
 * spell into a scroll). For a spell of level N (1..9):
 *
 *   - daysRequired = max(2, 2 × N)  // L1 still takes 2 days (basic ink)
 *   - gpRequired   = N² × 25 + 25   // L1 = 50, L2 = 125, L3 = 250, …
 *
 * Cantrips (N=0) are a special case: 1 day / 15 gp (rough estimate
 * matching the entry for spell scroll, cantrip in the DMG Magic Item
 * pricing table).
 */
export function scrollCraftingRequirements(spellLevel: CraftingSpellLevel): CraftingRequirements {
  if (spellLevel === 0) return { daysRequired: 1, gpRequired: 15 };
  return {
    daysRequired: Math.max(2, 2 * spellLevel),
    gpRequired: spellLevel * spellLevel * 25 + 25,
  };
}

/**
 * Healer's Kit / alchemy potion brewing. Treat the potion as a magic
 * item whose rarity tracks the source spell's level:
 *
 *   - L0..L1 → common (4 days / 50 gp)
 *   - L2..L3 → uncommon (20 days / 200 gp)
 *   - L4..L5 → rare (100 days / 2 000 gp)
 *   - L6..L9 → very rare (500 days / 20 000 gp)
 *
 * The bracket map mirrors the DMG's "Potion of Healing"-style entries
 * where L1 healing potions are common, while higher-tier elixirs scale
 * with the embedded spell's power.
 */
export function potionCraftingRequirements(spellLevel: CraftingSpellLevel): CraftingRequirements {
  if (spellLevel <= 1) return magicItemCraftingRequirements('common');
  if (spellLevel <= 3) return magicItemCraftingRequirements('uncommon');
  if (spellLevel <= 5) return magicItemCraftingRequirements('rare');
  return magicItemCraftingRequirements('very_rare');
}

/** Utility for the tool layer: validate a kind is one of the four legal
 *  crafting kinds before dispatching to the right helper. */
export const CRAFTING_KINDS: ReadonlyArray<CraftingKind> = [
  'item',
  'magic_item',
  'scroll',
  'potion',
];

export function isValidCraftingKind(kind: unknown): kind is CraftingKind {
  return typeof kind === 'string' && (CRAFTING_KINDS as readonly string[]).includes(kind);
}

export const CRAFTABLE_RARITIES: ReadonlyArray<CraftableRarity> = [
  'common',
  'uncommon',
  'rare',
  'very_rare',
  'legendary',
];

export function isValidCraftableRarity(rarity: unknown): rarity is CraftableRarity {
  return (
    typeof rarity === 'string' && (CRAFTABLE_RARITIES as readonly string[]).includes(rarity)
  );
}
