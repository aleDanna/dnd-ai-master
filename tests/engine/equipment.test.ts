import { describe, it, expect } from 'vitest';
import { equip, unequip, recomputeAC } from '@/engine/equipment';
import type { ArmorSpec, ArmorSpecMap } from '@/srd/catalog';
import type { Character } from '@/engine/types';

// Fixed test armor map: enough rows to exercise unarmored, light, heavy, shield.
const TEST_ARMOR: ArmorSpecMap = new Map<string, ArmorSpec>([
  ['leather',    { base: 11, dexCap: 'unlimited', category: 'Light',  stealthDisadvantage: false }],
  ['chain-mail', { base: 16, dexCap: 'none',      category: 'Heavy',  stealthDisadvantage: true  }],
  ['shield',     { base: 0,  dexCap: 'none',      category: 'Shield', stealthDisadvantage: false, shieldBonus: 2 }],
]);

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 1, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 12, ac: 12, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [],
  inventory: [
    { slug: 'leather', qty: 1, equipped: false },
    { slug: 'shield', qty: 1, equipped: false },
    { slug: 'longsword', qty: 1, equipped: false },
  ],
  hitDiceMax: 1, hitDieSize: 10,
};

describe('equip', () => {
  it('marks the item equipped', () => {
    const r = equip({ char: fighter, itemSlug: 'leather' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_equipped', characterId: 'pc1', itemSlug: 'leather', equipped: true });
  });

  it('refuses if item not in inventory', () => {
    const r = equip({ char: fighter, itemSlug: 'nonexistent' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_in_inventory');
  });
});

describe('unequip', () => {
  it('marks equipped → false', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'leather', qty: 1, equipped: true }],
    };
    const r = unequip({ char: equipped, itemSlug: 'leather' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_equipped', characterId: 'pc1', itemSlug: 'leather', equipped: false });
  });
});

describe('recomputeAC', () => {
  it('leather + DEX (2) = 13', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'leather', qty: 1, equipped: true }],
    };
    const r = recomputeAC({ char: equipped, armorSpecs: TEST_ARMOR });
    expect(r.data?.newAc).toBe(11 + 2);
    expect(r.mutations[0]).toEqual({ op: 'recompute_ac', characterId: 'pc1', newAc: 13 });
  });

  it('chain-mail caps DEX (heavy → no DEX)', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'chain-mail', qty: 1, equipped: true }],
    };
    const r = recomputeAC({ char: equipped, armorSpecs: TEST_ARMOR });
    expect(r.data?.newAc).toBe(16);                        // base 16, no DEX
  });

  it('shield adds +2', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'leather', qty: 1, equipped: true }, { slug: 'shield', qty: 1, equipped: true }],
    };
    const r = recomputeAC({ char: equipped, armorSpecs: TEST_ARMOR });
    expect(r.data?.newAc).toBe(11 + 2 + 2);
  });

  it('no armor → 10 + DEX (unarmored)', () => {
    const r = recomputeAC({ char: fighter, armorSpecs: TEST_ARMOR });
    expect(r.data?.newAc).toBe(10 + 2);
  });
});
