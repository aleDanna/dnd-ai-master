import { describe, it, expect } from 'vitest';
import { STARTING_KITS, getStartingKit, resolveKitItems } from '@/srd/starting-kits';
import { BACKGROUND_EQUIPMENT, getBackgroundEquipment } from '@/srd/starting-bg-equipment';

describe('STARTING_KITS', () => {
  it('covers all 12 PHB classes', () => {
    const expected = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];
    for (const c of expected) expect(STARTING_KITS[c], `missing kit for ${c}`).toBeDefined();
  });

  it('every choice has at least 2 options', () => {
    for (const [cls, kit] of Object.entries(STARTING_KITS)) {
      for (const choice of kit.choices) {
        expect(choice.options.length, `${cls}/${choice.label}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('every option has at least 1 item with positive qty', () => {
    for (const [cls, kit] of Object.entries(STARTING_KITS)) {
      for (const choice of kit.choices) {
        for (const opt of choice.options) {
          expect(opt.items.length, `${cls}/${choice.label}/${opt.label}`).toBeGreaterThan(0);
          for (const it of opt.items) expect(it.qty).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('resolveKitItems', () => {
  it('merges required + chosen options stacking same slugs', () => {
    const kit = STARTING_KITS.barbarian!;
    const items = resolveKitItems(kit, [0, 0]);
    const map = new Map(items.map((i) => [i.slug, i.qty]));
    expect(map.get('javelin')).toBe(4);
    expect(map.get('explorers-pack')).toBe(1);
    expect(map.get('greataxe')).toBe(1);
    expect(map.get('handaxe')).toBe(2);
  });

  it('falls back to option 0 when index is missing', () => {
    const kit = STARTING_KITS.fighter!;
    const items = resolveKitItems(kit, []);
    expect(items.find((i) => i.slug === 'chain-mail')).toBeDefined();      // first armor option
  });

  it('falls back to option 0 when index out of range', () => {
    const kit = STARTING_KITS.fighter!;
    const items = resolveKitItems(kit, [99, 99, 99, 99]);
    expect(items.find((i) => i.slug === 'chain-mail')).toBeDefined();
  });

  it('lets the player swap to alternate options', () => {
    const kit = STARTING_KITS.fighter!;
    // option 1 of armor: leather + longbow + arrows
    const items = resolveKitItems(kit, [1, 0, 0, 0]);
    const map = new Map(items.map((i) => [i.slug, i.qty]));
    expect(map.get('leather')).toBe(1);
    expect(map.get('longbow')).toBe(1);
    expect(map.get('arrows-20')).toBe(1);
    expect(map.get('chain-mail')).toBeUndefined();
  });
});

describe('BACKGROUND_EQUIPMENT', () => {
  it('covers all 13 PHB backgrounds', () => {
    const expected = ['acolyte', 'charlatan', 'criminal', 'entertainer', 'folk-hero', 'guild-artisan', 'hermit', 'noble', 'outlander', 'sage', 'sailor', 'soldier', 'urchin'];
    for (const b of expected) expect(BACKGROUND_EQUIPMENT[b], `missing bg eq for ${b}`).toBeDefined();
  });

  it('every entry includes some gold', () => {
    for (const [bg, items] of Object.entries(BACKGROUND_EQUIPMENT)) {
      const gold = items.find((i) => i.slug === 'gp');
      expect(gold, `${bg}: missing gp`).toBeDefined();
      expect(gold!.qty).toBeGreaterThan(0);
    }
  });
});

describe('getStartingKit / getBackgroundEquipment', () => {
  it('returns null kit for unknown classes', () => {
    expect(getStartingKit(null)).toBeNull();
    expect(getStartingKit('not-a-class')).toBeNull();
  });
  it('returns [] for unknown backgrounds', () => {
    expect(getBackgroundEquipment(null)).toEqual([]);
    expect(getBackgroundEquipment('not-a-bg')).toEqual([]);
  });
});
