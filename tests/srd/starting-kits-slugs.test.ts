import { describe, it, expect, afterAll } from 'vitest';
import { STARTING_KITS } from '@/srd/starting-kits';
import { BACKGROUND_EQUIPMENT } from '@/srd/starting-bg-equipment';
import { lookupCatalogItem } from '@/srd/catalog';
import { pool } from '@/db/client';

afterAll(async () => {
  await pool.end();
});

// Guards against typos in starting-kits.ts / starting-bg-equipment.ts. Every
// slug we hand to the player at character creation MUST resolve in the
// catalog (otherwise add_item validation would later reject it).
describe('starting kit slugs all resolve in the catalog', () => {
  it('class kit slugs', async () => {
    const slugs = new Set<string>();
    for (const kit of Object.values(STARTING_KITS)) {
      for (const it of kit.required) slugs.add(it.slug);
      for (const c of kit.choices) for (const o of c.options) for (const it of o.items) slugs.add(it.slug);
    }
    const slugList = [...slugs];
    const results = await Promise.all(slugList.map((s) => lookupCatalogItem(s)));
    const failures = slugList.filter((_, i) => results[i] == null);
    expect(failures, `unresolved kit slugs: ${failures.join(', ')}`).toEqual([]);
  }, 30_000);

  it('background equipment slugs', async () => {
    const slugs = new Set<string>();
    for (const items of Object.values(BACKGROUND_EQUIPMENT)) for (const it of items) slugs.add(it.slug);
    const slugList = [...slugs];
    const results = await Promise.all(slugList.map((s) => lookupCatalogItem(s)));
    const failures = slugList.filter((_, i) => results[i] == null);
    expect(failures, `unresolved bg slugs: ${failures.join(', ')}`).toEqual([]);
  }, 30_000);
});
