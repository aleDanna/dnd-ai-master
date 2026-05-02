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
