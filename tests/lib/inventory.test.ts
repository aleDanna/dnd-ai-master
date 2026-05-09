import { describe, it, expect } from 'vitest';
import { categorizeInventory, formatInventoryDisplay, slugToLabel } from '@/lib/inventory';
import type { MasterInventoryView } from '@/srd/enrich-inventory';

describe('categorizeInventory', () => {
  it('returns empty buckets for an empty inventory', () => {
    const c = categorizeInventory([]);
    expect(c.currency).toEqual([]);
    expect(c.equipped).toEqual([]);
    expect(c.other).toEqual([]);
    expect(c.totalCopper).toBe(0);
  });

  it('separates currency from regular items by slug', () => {
    const c = categorizeInventory([
      { slug: 'gp', qty: 50, equipped: false },
      { slug: 'longbow', qty: 1, equipped: true },
      { slug: 'rope-hempen', qty: 1, equipped: false },
    ]);
    expect(c.currency).toEqual([{ code: 'gp', qty: 50 }]);
    expect(c.equipped.map((i) => i.slug)).toEqual(['longbow']);
    expect(c.other.map((i) => i.slug)).toEqual(['rope-hempen']);
  });

  it('sums duplicate currency slugs and sorts pp > gp > ep > sp > cp', () => {
    const c = categorizeInventory([
      { slug: 'cp', qty: 17, equipped: false },
      { slug: 'gp', qty: 10, equipped: false },
      { slug: 'gp', qty: 5, equipped: false },
      { slug: 'pp', qty: 1, equipped: false },
      { slug: 'sp', qty: 25, equipped: false },
    ]);
    expect(c.currency).toEqual([
      { code: 'pp', qty: 1 },
      { code: 'gp', qty: 15 },
      { code: 'sp', qty: 25 },
      { code: 'cp', qty: 17 },
    ]);
    // Total in copper: 1*1000 + 15*100 + 25*10 + 17 = 2767
    expect(c.totalCopper).toBe(2767);
  });

  it('recognises natural-language currency aliases', () => {
    const c = categorizeInventory([
      { slug: 'gold', qty: 7, equipped: false },
      { slug: 'silver', qty: 3, equipped: false },
    ]);
    expect(c.currency).toEqual([
      { code: 'gp', qty: 7 },
      { code: 'sp', qty: 3 },
    ]);
  });

  it('omits zero-quantity currency rows', () => {
    const c = categorizeInventory([{ slug: 'gp', qty: 5, equipped: false }]);
    expect(c.currency.find((x) => x.code === 'sp')).toBeUndefined();
    expect(c.currency.length).toBe(1);
  });
});

describe('slugToLabel', () => {
  it('title-cases dashes', () => {
    expect(slugToLabel('rope-hempen')).toBe('Rope Hempen');
    expect(slugToLabel('potion-healing')).toBe('Potion Healing');
  });

  it('handles single-word slugs', () => {
    expect(slugToLabel('longbow')).toBe('Longbow');
  });

  it('returns empty string on empty input', () => {
    expect(slugToLabel('')).toBe('');
  });
});

describe('formatInventoryDisplay', () => {
  it('falls back to slugToLabel when no enriched view is provided', () => {
    expect(formatInventoryDisplay('rope-hempen-50ft')).toEqual({
      label: 'Rope Hempen 50ft',
      isNarrative: false,
    });
  });

  it('uses enriched name for SRD weapons', () => {
    const view: MasterInventoryView = { slug: 'longsword', qty: 1, equipped: true, kind: 'weapon', name: 'Longsword' };
    expect(formatInventoryDisplay('longsword', view)).toEqual({
      label: 'Longsword',
      isNarrative: false,
    });
  });

  it('appends "(narrativo)" for non-magical named items', () => {
    const view: MasterInventoryView = {
      slug: 'strano-amuleto-di-osso',
      qty: 1,
      equipped: false,
      kind: 'named_item',
      name: 'Strano amuleto di osso',
      magical: false,
    };
    expect(formatInventoryDisplay('strano-amuleto-di-osso', view)).toEqual({
      label: 'Strano amuleto di osso (narrativo)',
      isNarrative: true,
    });
  });

  it('does NOT append "(narrativo)" for magical named items', () => {
    const view: MasterInventoryView = {
      slug: 'spada-di-aldric',
      qty: 1,
      equipped: true,
      kind: 'named_item',
      name: 'Spada di Aldric',
      magical: true,
    };
    expect(formatInventoryDisplay('spada-di-aldric', view)).toEqual({
      label: 'Spada di Aldric',
      isNarrative: false,
    });
  });

  it('handles named_item with name absent (codex row missing on first paint)', () => {
    const view: MasterInventoryView = {
      slug: 'lettera-cifrata',
      qty: 1,
      kind: 'named_item',
      // No name field — defensive fallback to slugToLabel.
    } as MasterInventoryView;
    expect(formatInventoryDisplay('lettera-cifrata', view)).toEqual({
      label: 'Lettera Cifrata',
      isNarrative: false,
    });
  });
});
