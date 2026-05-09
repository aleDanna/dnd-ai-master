import { describe, it, expect, afterAll } from 'vitest';
import { enrichInventoryItems, formatEnrichedForMaster } from '@/srd/enrich-inventory';
import { pool } from '@/db/client';

afterAll(async () => {
  await pool.end();
});

describe('enrichInventoryItems', () => {
  it('looks up weapons, armor, gear, and currency in a single batch', async () => {
    const items = [
      { slug: 'longsword', qty: 1, equipped: true },
      { slug: 'leather', qty: 1, equipped: false },
      { slug: 'rope-hempen-50ft', qty: 2, equipped: false },
      { slug: 'gp', qty: 50, equipped: false },
      { slug: 'unknown-thing', qty: 1, equipped: false },
    ];
    const enriched = await enrichInventoryItems(items);
    expect(enriched).toHaveLength(5);

    const weapon = enriched.find((e) => e.slug === 'longsword');
    expect(weapon?.kind).toBe('weapon');
    if (weapon?.kind === 'weapon') expect(weapon.row.name).toMatch(/longsword/i);

    const armor = enriched.find((e) => e.slug === 'leather');
    expect(armor?.kind).toBe('armor');
    if (armor?.kind === 'armor') expect(armor.row.category).toBe('Light');

    const gear = enriched.find((e) => e.slug === 'rope-hempen-50ft');
    expect(gear?.kind).toBe('gear');
    if (gear?.kind === 'gear') expect(gear.row.name).toMatch(/rope/i);

    const coin = enriched.find((e) => e.slug === 'gp');
    expect(coin?.kind).toBe('currency');

    const unknown = enriched.find((e) => e.slug === 'unknown-thing');
    expect(unknown?.kind).toBe('unknown');
  });

  it('preserves qty and equipped on every entry', async () => {
    const items = [{ slug: 'longsword', qty: 3, equipped: true }];
    const [enriched] = await enrichInventoryItems(items);
    expect(enriched).toMatchObject({ slug: 'longsword', qty: 3, equipped: true });
  });

  it('returns [] for empty input without any DB calls', async () => {
    const enriched = await enrichInventoryItems([]);
    expect(enriched).toEqual([]);
  });
});

describe('formatEnrichedForMaster', () => {
  it('includes weapon damage / armor formula / gear category in the JSON view', async () => {
    const items = [
      { slug: 'longsword', qty: 1, equipped: true },
      { slug: 'leather', qty: 1, equipped: true },
      { slug: 'gp', qty: 12, equipped: false },
    ];
    const enriched = await enrichInventoryItems(items);
    const view = formatEnrichedForMaster(enriched);
    const lsw = view.find((v) => v.slug === 'longsword');
    expect(lsw?.damage).toBeDefined();
    const ar = view.find((v) => v.slug === 'leather');
    expect(ar?.ac).toBeDefined();
    const coin = view.find((v) => v.slug === 'gp');
    expect(coin?.kind).toBe('currency');
    expect(coin?.qty).toBe(12);
  });
});
