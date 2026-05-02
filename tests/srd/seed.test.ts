import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';

describe('seed integration', () => {
  beforeAll(async () => {
    // sanity: tables exist
    await db.execute(sql`select 1`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has populated every SRD table', async () => {
    const tables = [
      'srd_class', 'srd_race', 'srd_background', 'srd_feat', 'srd_condition',
      'srd_spell', 'srd_monster', 'srd_armor', 'srd_weapon', 'srd_gear', 'srd_rule_doc',
    ];
    for (const t of tables) {
      const r = await db.execute(sql.raw(`select count(*)::int as c from ${t}`));
      const row = r.rows[0] as { c: number };
      expect(row.c, `${t} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('has Magic Missile in srd_spell with the expected level', async () => {
    const r = await db.execute(sql`select level from srd_spell where slug = 'magic-missile'`);
    expect(r.rows[0]).toMatchObject({ level: 1 });
  });

  it('has the goblin monster with the expected CR', async () => {
    const r = await db.execute(sql`select cr from srd_monster where slug = 'goblin'`);
    expect(Number((r.rows[0] as { cr: string }).cr)).toBe(0.25);
  });
});
