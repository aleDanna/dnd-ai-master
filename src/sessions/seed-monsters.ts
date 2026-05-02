import { db } from '@/db/client';
import { combatActors, type CombatActorInsert } from '@/db/schema';
import { lookupMonster } from '@/srd/lookup';

export async function seedMonster(sessionId: string, monsterSlug: string, count: number = 1): Promise<string[]> {
  const monster = await lookupMonster(monsterSlug);
  if (!monster) throw new Error(`seedMonster: unknown slug "${monsterSlug}"`);
  const rows: CombatActorInsert[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      sessionId,
      name: count > 1 ? `${monster.name} ${i + 1}` : monster.name,
      monsterSlug: monster.slug,
      hpCurrent: monster.hp,
      hpMax: monster.hp,
      custom: {
        ac: monster.ac,
        abilities: { STR: monster.str, DEX: monster.dex, CON: monster.con, INT: monster.int, WIS: monster.wis, CHA: monster.cha },
        proficiencyBonus: 2,
        initiativeBonus: Math.floor((monster.dex - 10) / 2),
        resistances: monster.damageResistances,
        immunities: monster.damageImmunities,
        vulnerabilities: [],
        conditionImmunities: monster.conditionImmunities,
      },
    });
  }
  const inserted = await db.insert(combatActors).values(rows).returning({ id: combatActors.id });
  return inserted.map((r) => r.id);
}
