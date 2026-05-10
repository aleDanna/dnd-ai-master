import type { ActionResult, Character } from './types';
import { abilityModifier } from './modifiers';

export interface EquipInput {
  char: Character;
  itemSlug: string;
}

export function equip(input: EquipInput): ActionResult<{ equipped: boolean }> {
  const item = input.char.inventory.find((i) => i.slug === input.itemSlug);
  if (!item) return { ok: false, error: 'not_in_inventory', rolls: [], mutations: [] };
  return {
    ok: true,
    data: { equipped: true },
    rolls: [],
    mutations: [{ op: 'set_equipped', characterId: input.char.id, itemSlug: input.itemSlug, equipped: true }],
  };
}

export function unequip(input: EquipInput): ActionResult<{ equipped: boolean }> {
  const item = input.char.inventory.find((i) => i.slug === input.itemSlug);
  if (!item) return { ok: false, error: 'not_in_inventory', rolls: [], mutations: [] };
  return {
    ok: true,
    data: { equipped: false },
    rolls: [],
    mutations: [{ op: 'set_equipped', characterId: input.char.id, itemSlug: input.itemSlug, equipped: false }],
  };
}

interface ArmorSpec {
  base: number;
  dexCap: number | 'none' | 'unlimited';
  category: 'Light' | 'Medium' | 'Heavy' | 'Shield';
}

// Minimal armor catalog. Plan B does not query the DB; Plan D will switch to
// `lookupArmor(slug)` once the AI master needs to handle obscure armor.
const ARMOR: Record<string, ArmorSpec> = {
  'padded':       { base: 11, dexCap: 'unlimited', category: 'Light' },
  'leather':      { base: 11, dexCap: 'unlimited', category: 'Light' },
  'studded-leather': { base: 12, dexCap: 'unlimited', category: 'Light' },
  'hide':         { base: 12, dexCap: 2, category: 'Medium' },
  'chain-shirt':  { base: 13, dexCap: 2, category: 'Medium' },
  'scale-mail':   { base: 14, dexCap: 2, category: 'Medium' },
  'breastplate':  { base: 14, dexCap: 2, category: 'Medium' },
  'half-plate':   { base: 15, dexCap: 2, category: 'Medium' },
  'ring-mail':    { base: 14, dexCap: 'none', category: 'Heavy' },
  'chain-mail':   { base: 16, dexCap: 'none', category: 'Heavy' },
  'splint':       { base: 17, dexCap: 'none', category: 'Heavy' },
  'plate':        { base: 18, dexCap: 'none', category: 'Heavy' },
  'shield':       { base: 0,  dexCap: 'none', category: 'Shield' },
};

export interface RecomputeAcInput {
  char: Character;
  /** Optional armor spec map override (for DB-backed lookups). When omitted, uses
   *  the hardcoded ARMOR catalog. */
  armorSpecs?: Record<string, ArmorSpec>;
}

interface ArmorSpec {
  base: number;
  dexCap: 'unlimited' | 'none' | number;
  category: 'Light' | 'Medium' | 'Heavy' | 'Shield';
}

export function recomputeAC(input: RecomputeAcInput): ActionResult<{ newAc: number }> {
  const equippedItems = input.char.inventory.filter((i) => i.equipped);
  const armorPiece = equippedItems.find((i) => {
    const spec = ARMOR[i.slug];
    return spec && spec.category !== 'Shield';
  });
  const hasShield = equippedItems.some((i) => i.slug === 'shield');
  const dexMod = abilityModifier(input.char.abilities.DEX);

  let ac: number;
  if (!armorPiece) {
    ac = 10 + dexMod;
  } else {
    const spec = ARMOR[armorPiece.slug]!;
    let dexBonus = 0;
    if (spec.dexCap === 'unlimited') dexBonus = dexMod;
    else if (spec.dexCap === 'none') dexBonus = 0;
    else dexBonus = Math.min(dexMod, spec.dexCap);
    ac = spec.base + dexBonus;
  }
  if (hasShield) ac += 2;

  return {
    ok: true,
    data: { newAc: ac },
    rolls: [],
    mutations: [{ op: 'recompute_ac', characterId: input.char.id, newAc: ac }],
  };
}
