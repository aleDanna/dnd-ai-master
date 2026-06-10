/**
 * 2026-06-10 audit — server-owned PC attack profile (D&D 5e RAW).
 *
 * Before this module the vault combat path trusted the MODEL for the attack
 * math and hardcoded the damage request as `1d6 + <to-hit bonus>`:
 *
 *   - the weapon's real damage die was ignored (a greatsword rolled 1d6);
 *   - the damage modifier reused the full TO-HIT bonus — ability mod PLUS
 *     proficiency — but proficiency is NEVER added to damage (rules.md §1.1,
 *     §10: damage = weapon dice + ability modifier only);
 *   - a natural 20 never doubled the damage dice (rules.md: crit doubles
 *     dice, not the modifier).
 *
 * This module derives the profile from the character sheet (Postgres
 * `characters` row: abilities + level + equipped inventory) and the SRD
 * weapon table:
 *
 *   attackBonus = ability mod + proficiency bonus      (to-hit requests)
 *   damageDice  = the weapon's dice term, e.g. "1d8"   (doubled on a crit
 *                 by the resolver, never here)
 *   damageMod   = ability mod ONLY
 *
 * Ability selection follows RAW: ranged weapons use DEX, finesse weapons use
 * the better of STR/DEX, everything else STR. Weapon proficiency is assumed
 * (fine-grained class/weapon proficiency matching is out of scope — PCs
 * almost always equip weapons they are proficient with).
 *
 * `buildPcAttackProfile` is PURE (unit-testable); `loadPcAttackProfile` is
 * the DB-facing wrapper the route calls.
 */
import { inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { srdWeapon } from '@/db/schema';
import { abilityModifier, proficiencyBonusForLevel } from '@/engine';

export interface PcAttackProfile {
  /** d20 to-hit modifier: ability mod + proficiency bonus. */
  attackBonus: number;
  /** Weapon dice term only (e.g. "1d8") — no flat part. */
  damageDice: string;
  /** Damage modifier: ability mod ONLY (proficiency never applies). */
  damageMod: number;
}

export interface PcWeaponInfo {
  /** SRD damage term, e.g. "1d8". */
  damage: string;
  /** SRD properties array (matched case-insensitively for "Finesse"). */
  properties: string[];
  /** SRD category, e.g. "Martial Ranged" (matched for /ranged/i). */
  category: string;
}

/** Pure core — derives the profile from sheet data + one weapon. */
export function buildPcAttackProfile(input: {
  abilities: { STR: number; DEX: number };
  level: number;
  weapon: PcWeaponInfo | null;
}): PcAttackProfile | null {
  if (!input.weapon) return null;
  const diceM = /^(\d*)\s*d\s*(\d+)/i.exec(input.weapon.damage.trim());
  if (!diceM) return null; // non-dice damage entry (e.g. "—" for net) → no profile
  const damageDice = `${diceM[1] || '1'}d${diceM[2]}`;

  const strMod = abilityModifier(input.abilities.STR);
  const dexMod = abilityModifier(input.abilities.DEX);
  const ranged = /ranged/i.test(input.weapon.category);
  const finesse = input.weapon.properties.some((p) => /finesse/i.test(p));
  const damageMod = ranged ? dexMod : finesse ? Math.max(strMod, dexMod) : strMod;

  const level = Math.min(20, Math.max(1, Math.trunc(input.level) || 1));
  return {
    attackBonus: damageMod + proficiencyBonusForLevel(level),
    damageDice,
    damageMod,
  };
}

/** Average roll of a dice term — used to pick the "main" equipped weapon. */
function avgDamage(damage: string): number {
  const m = /^(\d*)\s*d\s*(\d+)/i.exec(damage.trim());
  if (!m) return 0;
  const count = parseInt(m[1] || '1', 10);
  const size = parseInt(m[2]!, 10);
  return count * ((size + 1) / 2);
}

/**
 * DB-facing wrapper: equipped inventory slugs → SRD weapon rows → profile.
 * With multiple equipped weapons, picks the highest average damage (the
 * "main hand" heuristic). Returns null (caller falls back to the legacy
 * defaults) when nothing equipped matches an SRD weapon.
 */
export async function loadPcAttackProfile(row: {
  abilities: { STR: number; DEX: number };
  level: number;
  inventory: { slug: string; qty: number; equipped: boolean }[] | null;
}): Promise<PcAttackProfile | null> {
  const equippedSlugs = (row.inventory ?? [])
    .filter((i) => i.equipped && i.qty > 0)
    .map((i) => i.slug);
  if (equippedSlugs.length === 0) return null;
  const weapons = await db
    .select({ slug: srdWeapon.slug, damage: srdWeapon.damage, properties: srdWeapon.properties, category: srdWeapon.category })
    .from(srdWeapon)
    .where(inArray(srdWeapon.slug, equippedSlugs));
  if (weapons.length === 0) return null;
  const main = [...weapons].sort((a, b) => avgDamage(b.damage) - avgDamage(a.damage))[0]!;
  return buildPcAttackProfile({ abilities: row.abilities, level: row.level, weapon: main });
}
