import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  srdArmor, srdWeapon, srdGear,
  type SrdArmor, type SrdWeapon, type SrdGear,
} from '@/db/schema';
import { lookupNamedItemBySlug } from './lookup-codex-named-item';

// ─── Currency ──────────────────────────────────────────────────────────────
// Coin slugs aren't in any srd_* table (gp/sp/cp/ep/pp). They're valid
// inventory entries and must pass slug validation — we treat them as a
// distinct catalog kind.

export type CurrencyCode = 'gp' | 'sp' | 'cp' | 'ep' | 'pp';
export const CURRENCY_SLUGS: ReadonlySet<CurrencyCode> = new Set(['gp', 'sp', 'cp', 'ep', 'pp'] as const);
export function isCurrencySlug(slug: string): slug is CurrencyCode {
  return (CURRENCY_SLUGS as ReadonlySet<string>).has(slug);
}

// ─── AC formula parser ─────────────────────────────────────────────────────
// SRD `srd_armor.ac_formula` is a string like:
//   "11 + DEX mod"            → { base: 11, dexCap: 'unlimited' }
//   "14 + DEX mod (max 2)"    → { base: 14, dexCap: 2 }
//   "16"                       → { base: 16, dexCap: 'none' }
//   "+2"  (shield)             → { base: 0,  dexCap: 'none', shieldBonus: 2 }

export interface ParsedAcFormula {
  base: number;
  dexCap: number | 'unlimited' | 'none';
  shieldBonus?: number;
}

export function parseAcFormula(formula: string): ParsedAcFormula {
  const f = formula.trim();
  // Shield: "+N"
  const shieldMatch = /^\+(\d+)$/.exec(f);
  if (shieldMatch) {
    return { base: 0, dexCap: 'none', shieldBonus: parseInt(shieldMatch[1]!, 10) };
  }
  // Heavy: bare integer "16"
  const heavyMatch = /^(\d+)$/.exec(f);
  if (heavyMatch) {
    return { base: parseInt(heavyMatch[1]!, 10), dexCap: 'none' };
  }
  // Light/Medium: "N + DEX mod" optionally "(max M)"
  const dexMatch = /^(\d+)\s*\+\s*DEX\s*mod(?:\s*\(max\s*(\d+)\))?$/i.exec(f);
  if (dexMatch) {
    const base = parseInt(dexMatch[1]!, 10);
    const cap = dexMatch[2] != null ? parseInt(dexMatch[2], 10) : 'unlimited';
    return { base, dexCap: cap };
  }
  throw new Error(`parseAcFormula: cannot parse "${formula}"`);
}

// ─── Armor specs ───────────────────────────────────────────────────────────
// Engine equipment.recomputeAC() needs structured armor data. We derive it
// from srd_armor rows on demand — DB is the source of truth, no hardcoded
// duplicate map.

export interface ArmorSpec extends ParsedAcFormula {
  category: 'Light' | 'Medium' | 'Heavy' | 'Shield';
  stealthDisadvantage: boolean;
}

export type ArmorSpecMap = ReadonlyMap<string, ArmorSpec>;

function rowToSpec(row: SrdArmor): ArmorSpec {
  const parsed = parseAcFormula(row.acFormula);
  return {
    ...parsed,
    category: row.category as ArmorSpec['category'],
    stealthDisadvantage: row.stealthDisadvantage,
  };
}

export async function loadArmorSpecs(): Promise<ArmorSpecMap> {
  const rows = await db.select().from(srdArmor);
  const map = new Map<string, ArmorSpec>();
  for (const row of rows) {
    try {
      map.set(row.slug, rowToSpec(row));
    } catch (e) {
      // Swallow rows with malformed AC formula so one bad seed entry doesn't
      // brick the whole armor map. Surface in logs for the maintainer.
      console.warn(`[catalog] failed to parse AC for ${row.slug}: ${(e as Error).message}`);
    }
  }
  return map;
}

// ─── Unified lookup ────────────────────────────────────────────────────────
// Resolves a slug to whichever catalog it lives in (armor, weapon, gear,
// currency, or a session-scoped named_item from the codex). Returns null
// when the slug is unknown anywhere — callers use this to reject invalid
// add_item / equip targets.

export type CatalogItem =
  | { kind: 'armor'; row: SrdArmor }
  | { kind: 'weapon'; row: SrdWeapon }
  | { kind: 'gear'; row: SrdGear }
  | { kind: 'currency'; code: CurrencyCode }
  | { kind: 'named_item'; sessionId: string; slug: string; name: string; description: string; magical: boolean };

export interface LookupOptions {
  /** When provided, also searches codex_entities (named_item kind) scoped to this session. */
  sessionId?: string;
}

export async function lookupCatalogItem(
  slug: string,
  opts: LookupOptions = {},
): Promise<CatalogItem | null> {
  const s = slug.trim().toLowerCase();
  if (!s) return null;

  if (isCurrencySlug(s)) return { kind: 'currency', code: s };

  // Probe each SRD table by primary key. These are O(1) point lookups; we
  // could parallelise, but the round-trip cost on Supabase is dominated by the
  // first query — sequencing keeps the typical case (weapon found first) at
  // one network hop.
  const [weaponRow] = await db.select().from(srdWeapon).where(eq(srdWeapon.slug, s)).limit(1);
  if (weaponRow) return { kind: 'weapon', row: weaponRow };

  const [armorRow] = await db.select().from(srdArmor).where(eq(srdArmor.slug, s)).limit(1);
  if (armorRow) return { kind: 'armor', row: armorRow };

  const [gearRow] = await db.select().from(srdGear).where(eq(srdGear.slug, s)).limit(1);
  if (gearRow) return { kind: 'gear', row: gearRow };

  if (opts.sessionId) {
    const named = await lookupNamedItemBySlug(opts.sessionId, s);
    if (named) return named;
  }

  return null;
}
