import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  srdSpell, srdMonster, srdClass, srdRace, srdBackground, srdCondition,
  srdArmor, srdWeapon, srdGear, srdFeat, srdRuleDoc,
} from '@/db/schema';

export async function lookupSpell(slug: string) {
  const rows = await db.select().from(srdSpell).where(eq(srdSpell.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch ritual + concentration + castingTime + components for a spell. Returns
 * undefined if the spell isn't in the SRD table. Used by the cast_spell tool to:
 *   - validate `asRitual` casts (PHB §8.13: only ritual-tagged spells are eligible),
 *   - drive action-economy consumption (`castingTime` → action / bonus / reaction),
 *   - drive PHB §8.3 component validation (V/S/M parsed from the components string).
 * Defaults `castingTime` to '1 action' when the SRD column is null/empty;
 * defaults `components` to an empty string (no validation requested).
 */
export async function lookupSpellMeta(
  slug: string,
): Promise<
  | { ritual: boolean; concentration: boolean; castingTime: string; components: string }
  | undefined
> {
  const rows = await db
    .select({
      ritual: srdSpell.ritual,
      concentration: srdSpell.concentration,
      castingTime: srdSpell.castingTime,
      components: srdSpell.components,
    })
    .from(srdSpell)
    .where(eq(srdSpell.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ritual: !!row.ritual,
    concentration: !!row.concentration,
    castingTime: row.castingTime ?? '1 action',
    components: row.components ?? '',
  };
}

export async function lookupMonster(slug: string) {
  const rows = await db.select().from(srdMonster).where(eq(srdMonster.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupClass(slug: string) {
  const rows = await db.select().from(srdClass).where(eq(srdClass.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupRace(slug: string) {
  const rows = await db.select().from(srdRace).where(eq(srdRace.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupBackground(slug: string) {
  const rows = await db.select().from(srdBackground).where(eq(srdBackground.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupCondition(slug: string) {
  const rows = await db.select().from(srdCondition).where(eq(srdCondition.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupArmor(slug: string) {
  const rows = await db.select().from(srdArmor).where(eq(srdArmor.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupWeapon(slug: string) {
  const rows = await db.select().from(srdWeapon).where(eq(srdWeapon.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupGear(slug: string) {
  const rows = await db.select().from(srdGear).where(eq(srdGear.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupFeat(slug: string) {
  const rows = await db.select().from(srdFeat).where(eq(srdFeat.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function lookupRule(sectionPath: string) {
  const rows = await db.select().from(srdRuleDoc).where(eq(srdRuleDoc.sectionPath, sectionPath)).limit(1);
  return rows[0] ?? null;
}

export type Pagination = { limit: number; offset: number };

export async function listSpells(p: Pagination = { limit: 50, offset: 0 }) {
  return db.select().from(srdSpell).orderBy(asc(srdSpell.name)).limit(p.limit).offset(p.offset);
}

export async function listMonsters(p: Pagination = { limit: 50, offset: 0 }) {
  return db.select().from(srdMonster).orderBy(asc(srdMonster.name)).limit(p.limit).offset(p.offset);
}

export async function listClasses() {
  return db.select().from(srdClass).orderBy(asc(srdClass.name));
}

export async function listRaces() {
  return db.select().from(srdRace).orderBy(asc(srdRace.name));
}

export async function listBackgrounds() {
  return db.select().from(srdBackground).orderBy(asc(srdBackground.name));
}
