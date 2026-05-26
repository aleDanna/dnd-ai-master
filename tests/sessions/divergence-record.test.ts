/**
 * Phase 03-A plan 03-A-09 task 4 — recordDivergence audit-writer tests.
 *
 * Smoke-tests the thin DB wrapper in isolation:
 *   1. Insert + read-back preserves all ParityResult fields (jsonb shape).
 *   2. characterId === null is accepted (session-level divergences).
 *
 * Skips at runtime if DATABASE_URL absent. Uses the same raw-SQL fixture
 * pattern as tests/db/dual-write-divergences.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import {
  sessions,
  campaigns,
  dualWriteDivergences,
} from '@/db/schema';
import { recordDivergence } from '@/sessions/divergence-record';

const HAS_DB = !!process.env.DATABASE_URL;

const TEST_USER = 'user_dr_' + Date.now();
let SESSION_ID = '';
let CAMPAIGN_ID = '';
let CHAR_ID = '';

(HAS_DB ? describe : describe.skip)('recordDivergence', () => {
  beforeAll(async () => {
    // Minimal user row.
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    // Character row — raw SQL bypasses the broken saveCharacter pipeline
    // (deferred-items.md tracker). The character itself is never inspected
    // by this suite — it exists to satisfy the sessions.character_id FK.
    const charResult = await db.execute(sql`
      insert into characters (
        user_id, name, race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size
      ) values (
        ${TEST_USER}, 'Divergence Test Subject', 'human', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 })}::jsonb,
        2, 10, 12, 30,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 8
      )
      returning id
    `);
    CHAR_ID = (charResult.rows[0] as { id: string }).id;

    const [campaign] = await db
      .insert(campaigns)
      .values({ userId: TEST_USER, name: 'recordDivergence test', premise: 'x' })
      .returning();
    CAMPAIGN_ID = campaign!.id;

    const [s] = await db
      .insert(sessions)
      .values({
        userId: TEST_USER,
        characterId: CHAR_ID,
        campaignId: campaign!.id,
        premise: 'x',
      })
      .returning();
    SESSION_ID = s!.id;
  });

  afterAll(async () => {
    await db.execute(
      sql`delete from dual_write_divergences where session_id = ${SESSION_ID}`,
    );
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('inserts a row preserving all ParityResult fields (insert + read-back)', async () => {
    await recordDivergence({
      sessionId: SESSION_ID,
      campaignId: CAMPAIGN_ID,
      characterId: CHAR_ID,
      eventType: 'hp_change',
      parityResult: {
        diverged: true,
        summary: 'hp_current: vault=20, postgres=15',
        vault: { hp_current: 20, conditions: ['poisoned'] },
        postgres: { hp_current: 15, conditions: [] },
      },
    });
    const rows = await db
      .select()
      .from(dualWriteDivergences)
      .where(eq(dualWriteDivergences.sessionId, SESSION_ID))
      .orderBy(dualWriteDivergences.createdAt);
    const matching = rows.filter(
      (r) => r.eventType === 'hp_change' && r.characterId === CHAR_ID,
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const row = matching[matching.length - 1]!;
    expect(row.eventType).toBe('hp_change');
    expect(row.characterId).toBe(CHAR_ID);
    expect(row.summary).toBe('hp_current: vault=20, postgres=15');
    // jsonb round-trip — nested arrays + primitives preserved structurally.
    expect(row.vaultState).toEqual({ hp_current: 20, conditions: ['poisoned'] });
    expect(row.postgresState).toEqual({ hp_current: 15, conditions: [] });
    // Postgres defaults filled by the schema (uuid + timestamp).
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('accepts characterId === null (session-level divergence)', async () => {
    await recordDivergence({
      sessionId: SESSION_ID,
      campaignId: CAMPAIGN_ID,
      characterId: null,
      eventType: 'session_level',
      parityResult: {
        diverged: true,
        summary: 'flags: vault={a:true}, postgres={a:false}',
        vault: { flags: { a: true } },
        postgres: { flags: { a: false } },
      },
    });
    const rows = await db
      .select()
      .from(dualWriteDivergences)
      .where(eq(dualWriteDivergences.sessionId, SESSION_ID));
    const nullCharRow = rows.find(
      (r) => r.characterId === null && r.eventType === 'session_level',
    );
    expect(nullCharRow).toBeDefined();
    expect(nullCharRow!.vaultState).toEqual({ flags: { a: true } });
    expect(nullCharRow!.postgresState).toEqual({ flags: { a: false } });
  });
});
