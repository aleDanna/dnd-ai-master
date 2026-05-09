import { describe, it, expect, afterAll } from 'vitest';
import {
  parseAcFormula,
  isCurrencySlug,
  loadArmorSpecs,
  lookupCatalogItem,
  CURRENCY_SLUGS,
} from '@/srd/catalog';
import { pool } from '@/db/client';

describe('parseAcFormula', () => {
  it('parses Light "11 + DEX mod" → unlimited dex', () => {
    expect(parseAcFormula('11 + DEX mod')).toEqual({ base: 11, dexCap: 'unlimited' });
  });

  it('parses Medium "14 + DEX mod (max 2)" → cap 2', () => {
    expect(parseAcFormula('14 + DEX mod (max 2)')).toEqual({ base: 14, dexCap: 2 });
  });

  it('parses Heavy "16" → no dex', () => {
    expect(parseAcFormula('16')).toEqual({ base: 16, dexCap: 'none' });
  });

  it('parses Shield "+2" → bonus only', () => {
    expect(parseAcFormula('+2')).toEqual({ base: 0, dexCap: 'none', shieldBonus: 2 });
  });

  it('rejects unparsable formulas', () => {
    expect(() => parseAcFormula('garbage')).toThrow();
  });
});

describe('isCurrencySlug', () => {
  it('accepts standard codes', () => {
    for (const c of ['gp', 'sp', 'cp', 'ep', 'pp']) expect(isCurrencySlug(c)).toBe(true);
  });
  it('rejects others', () => {
    expect(isCurrencySlug('xp')).toBe(false);
    expect(isCurrencySlug('gold')).toBe(false);
    expect(isCurrencySlug('')).toBe(false);
  });
  it('exposes the canonical set', () => {
    expect(CURRENCY_SLUGS).toEqual(new Set(['gp', 'sp', 'cp', 'ep', 'pp']));
  });
});

afterAll(async () => {
  await pool.end();
});

describe('lookupCatalogItem (DB)', () => {
  it('finds a weapon by slug', async () => {
    const r = await lookupCatalogItem('longsword');
    expect(r?.kind).toBe('weapon');
    if (r?.kind === 'weapon') expect(r.row.name).toMatch(/longsword/i);
  });

  it('finds armor by slug', async () => {
    const r = await lookupCatalogItem('leather');
    expect(r?.kind).toBe('armor');
    if (r?.kind === 'armor') expect(r.row.category).toBe('Light');
  });

  it('finds gear by slug', async () => {
    const r = await lookupCatalogItem('rope-hempen-50ft');
    expect(r?.kind).toBe('gear');
  });

  it('classifies currency slugs without DB hit', async () => {
    const r = await lookupCatalogItem('gp');
    expect(r).toEqual({ kind: 'currency', code: 'gp' });
  });

  it('returns null for unknown slugs (no session)', async () => {
    const r = await lookupCatalogItem('does-not-exist');
    expect(r).toBeNull();
  });
});

describe('loadArmorSpecs (DB)', () => {
  it('builds a map keyed by slug with parsed specs', async () => {
    const specs = await loadArmorSpecs();
    expect(specs.get('leather')).toMatchObject({ base: 11, dexCap: 'unlimited', category: 'Light' });
    expect(specs.get('chain-mail')).toMatchObject({ base: 16, dexCap: 'none', category: 'Heavy' });
    expect(specs.get('half-plate')).toMatchObject({ base: 15, dexCap: 2, category: 'Medium' });
    expect(specs.get('shield')).toMatchObject({ category: 'Shield', shieldBonus: 2 });
  });
});
