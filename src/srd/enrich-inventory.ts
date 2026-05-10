import { inArray, and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  srdArmor, srdWeapon, srdGear,
  codexEntities, type CodexNamedItemData,
  type SrdArmor, type SrdWeapon, type SrdGear,
} from '@/db/schema';
import { isCurrencySlug } from './catalog';

export type InventoryItemKind = 'weapon' | 'armor' | 'gear' | 'currency' | 'named_item' | 'unknown';

// Each row in `character.inventory` is a `{slug, qty, equipped}` triple. To
// produce the master-facing snapshot we enrich each entry with the catalog
// metadata (name, damage, AC formula, …) so the master doesn't need to
// query the catalog per turn. The DB-side shape is unchanged — enrichment
// happens only when we serialise.
//
// The lookup is **batched**: one IN-query per catalog table (plus codex if a
// session is provided), regardless of inventory size. Inventories of up to
// a few dozen items finish in 3-4 round trips.

export interface InventoryRow {
  slug: string;
  qty: number;
  equipped: boolean;
}

export type EnrichedInventoryItem =
  | { slug: string; qty: number; equipped: boolean; kind: 'weapon'; row: SrdWeapon }
  | { slug: string; qty: number; equipped: boolean; kind: 'armor'; row: SrdArmor }
  | { slug: string; qty: number; equipped: boolean; kind: 'gear'; row: SrdGear }
  | { slug: string; qty: number; equipped: boolean; kind: 'currency' }
  | {
      slug: string; qty: number; equipped: boolean;
      kind: 'named_item';
      name: string;
      description: string;
      magical: boolean;
    }
  | { slug: string; qty: number; equipped: boolean; kind: 'unknown' };

export async function enrichInventoryItems(
  items: ReadonlyArray<InventoryRow>,
  opts: { sessionId?: string } = {},
): Promise<EnrichedInventoryItem[]> {
  if (items.length === 0) return [];

  const slugs = items.map((i) => i.slug.trim().toLowerCase());
  const lookupSlugs = slugs.filter((s) => !isCurrencySlug(s));

  const [weaponRows, armorRows, gearRows, codexRows] = await Promise.all([
    lookupSlugs.length > 0
      ? db.select().from(srdWeapon).where(inArray(srdWeapon.slug, lookupSlugs))
      : Promise.resolve([] as SrdWeapon[]),
    lookupSlugs.length > 0
      ? db.select().from(srdArmor).where(inArray(srdArmor.slug, lookupSlugs))
      : Promise.resolve([] as SrdArmor[]),
    lookupSlugs.length > 0
      ? db.select().from(srdGear).where(inArray(srdGear.slug, lookupSlugs))
      : Promise.resolve([] as SrdGear[]),
    opts.sessionId && lookupSlugs.length > 0
      ? db
          .select()
          .from(codexEntities)
          .where(
            and(
              eq(codexEntities.sessionId, opts.sessionId),
              eq(codexEntities.kind, 'named_item'),
              inArray(codexEntities.slug, lookupSlugs),
            ),
          )
      : Promise.resolve([] as { slug: string; name: string; data: CodexNamedItemData }[]),
  ]);

  const weaponMap = new Map(weaponRows.map((r) => [r.slug, r]));
  const armorMap = new Map(armorRows.map((r) => [r.slug, r]));
  const gearMap = new Map(gearRows.map((r) => [r.slug, r]));
  const codexMap = new Map(codexRows.map((r) => [r.slug, r]));

  return items.map((item): EnrichedInventoryItem => {
    const slug = item.slug.trim().toLowerCase();
    const base = { slug, qty: item.qty, equipped: item.equipped };

    if (isCurrencySlug(slug)) return { ...base, kind: 'currency' };

    const weapon = weaponMap.get(slug);
    if (weapon) return { ...base, kind: 'weapon', row: weapon };

    const armor = armorMap.get(slug);
    if (armor) return { ...base, kind: 'armor', row: armor };

    const gear = gearMap.get(slug);
    if (gear) return { ...base, kind: 'gear', row: gear };

    const named = codexMap.get(slug);
    if (named) {
      const data = named.data as CodexNamedItemData;
      return {
        ...base,
        kind: 'named_item',
        name: named.name,
        description: data.description,
        magical: data.magical,
      };
    }

    // Pre-existing inventory rows from before catalog validation may carry
    // arbitrary slugs. We don't drop them — we tag them `unknown` so the
    // master can still see and reconcile them via narration.
    return { ...base, kind: 'unknown' };
  });
}

// ─── Master-facing JSON view ───────────────────────────────────────────────
// Compact projection of an enriched item that the master sees in the
// snapshot's JSON. We strip fields the master doesn't need (cost, weight,
// stealth penalty, …) to keep tokens down.

export interface MasterInventoryView {
  slug: string;
  qty: number;
  equipped?: boolean;
  kind: InventoryItemKind;
  name?: string;
  damage?: string;            // weapon
  damageType?: string;        // weapon
  properties?: string[];      // weapon
  ac?: string;                // armor
  category?: string;          // armor / gear
  description?: string;       // gear / named_item (truncated)
  magical?: boolean;          // named_item
}

const NAMED_ITEM_DESC_BUDGET = 120;

export function formatEnrichedForMaster(items: ReadonlyArray<EnrichedInventoryItem>): MasterInventoryView[] {
  return items.map((it) => {
    switch (it.kind) {
      case 'weapon':
        return {
          slug: it.slug, qty: it.qty, equipped: it.equipped, kind: 'weapon',
          name: it.row.name,
          damage: it.row.damage,
          damageType: it.row.damageType,
          properties: it.row.properties as string[] | undefined,
        };
      case 'armor':
        return {
          slug: it.slug, qty: it.qty, equipped: it.equipped, kind: 'armor',
          name: it.row.name,
          ac: it.row.acFormula,
          category: it.row.category,
        };
      case 'gear':
        return {
          slug: it.slug, qty: it.qty, equipped: it.equipped, kind: 'gear',
          name: it.row.name,
          category: it.row.category,
        };
      case 'currency':
        return { slug: it.slug, qty: it.qty, kind: 'currency' };
      case 'named_item':
        return {
          slug: it.slug, qty: it.qty, equipped: it.equipped, kind: 'named_item',
          name: it.name,
          description: it.description.length > NAMED_ITEM_DESC_BUDGET
            ? it.description.slice(0, NAMED_ITEM_DESC_BUDGET) + '…'
            : it.description,
          magical: it.magical,
        };
      case 'unknown':
        return { slug: it.slug, qty: it.qty, equipped: it.equipped, kind: 'unknown' };
    }
  });
}
