import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import {
  srdArmor, srdBackground, srdClass, srdCondition, srdFeat, srdGear,
  srdMonster, srdRace, srdRuleDoc, srdSpell, srdWeapon,
} from '@/db/schema';
import { parseArmor } from './parsers/armor';
import { parseBackgrounds } from './parsers/backgrounds';
import { parseClasses } from './parsers/classes';
import { parseConditions } from './parsers/conditions';
import { parseFeats } from './parsers/feats';
import { parseGear } from './parsers/gear';
import { parseMonsters } from './parsers/monsters';
import { parseRaces } from './parsers/races';
import { parseRules } from './parsers/rules';
import { parseSpells } from './parsers/spells';
import { parseWeapons } from './parsers/weapons';

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../data/${name}`, import.meta.url)), 'utf8');
}

async function reset() {
  console.log('[seed] --reset: truncating all SRD tables');
  await db.execute(sql`
    TRUNCATE TABLE
      srd_class, srd_race, srd_background, srd_feat, srd_condition,
      srd_spell, srd_monster, srd_armor, srd_weapon, srd_gear, srd_rule_doc
    RESTART IDENTITY CASCADE
  `);
}

async function seed() {
  const reset_flag = process.argv.includes('--reset');
  if (reset_flag) await reset();

  console.log('[seed] parsing CSVs');
  const classes = parseClasses(read('classes.csv'));
  const races = parseRaces(read('races.csv'));
  const backgrounds = parseBackgrounds(read('backgrounds.csv'));
  const feats = parseFeats(read('feats.csv'));
  const conditions = parseConditions(read('conditions.csv'));
  const spells = parseSpells(read('spells.csv'));
  const monsters = parseMonsters(read('monsters.csv'));
  const armor = parseArmor(read('equipment_armor.csv'));
  const weapons = parseWeapons(read('equipment_weapons.csv'));
  const gear = parseGear(read('equipment_gear.csv'));
  const rules = parseRules(read('rules.md'));

  console.log(`[seed] inserting: ${classes.length} classes, ${races.length} races, ${backgrounds.length} backgrounds, ${feats.length} feats, ${conditions.length} conditions, ${spells.length} spells, ${monsters.length} monsters, ${armor.length} armors, ${weapons.length} weapons, ${gear.length} gear items, ${rules.length} rule sections`);

  await db.transaction(async (tx) => {
    if (classes.length)     await tx.insert(srdClass).values(classes).onConflictDoNothing({ target: srdClass.slug });
    if (races.length)       await tx.insert(srdRace).values(races).onConflictDoNothing({ target: srdRace.slug });
    if (backgrounds.length) await tx.insert(srdBackground).values(backgrounds).onConflictDoNothing({ target: srdBackground.slug });
    if (feats.length)       await tx.insert(srdFeat).values(feats).onConflictDoNothing({ target: srdFeat.slug });
    if (conditions.length)  await tx.insert(srdCondition).values(conditions).onConflictDoNothing({ target: srdCondition.slug });
    if (spells.length)      await tx.insert(srdSpell).values(spells).onConflictDoNothing({ target: srdSpell.slug });
    if (monsters.length)    await tx.insert(srdMonster).values(monsters).onConflictDoNothing({ target: srdMonster.slug });
    if (armor.length)       await tx.insert(srdArmor).values(armor).onConflictDoNothing({ target: srdArmor.slug });
    if (weapons.length)     await tx.insert(srdWeapon).values(weapons).onConflictDoNothing({ target: srdWeapon.slug });
    if (gear.length)        await tx.insert(srdGear).values(gear).onConflictDoNothing({ target: srdGear.slug });
    if (rules.length)       await tx.insert(srdRuleDoc).values(rules).onConflictDoNothing({ target: srdRuleDoc.sectionPath });
  });

  console.log('[seed] done');
  await pool.end();
}

seed().catch(async (err) => {
  console.error('[seed] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
