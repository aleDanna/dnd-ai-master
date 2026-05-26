import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq, desc } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import {
  sessions,
  campaigns,
  dualWriteDivergences,
} from '@/db/schema';

/**
 * Phase 03-A plan 03-A-05 — schema smoke for the divergence audit table.
 *
 * Cases:
 *   1. insert + select round-trip (id is uuid, defaults work, jsonb roundtrips)
 *   2. (session_id, created_at DESC) index exists (proves migration ran fully)
 *   3. SELECT ordering by created_at DESC works (operator query shape)
 *   4. character_id is nullable (session-level divergences allowed per schema spec)
 *
 * Test pattern follows tests/sessions/applicator.test.ts (DB-dependent test;
 * fixtures cleaned in afterAll). Skips at runtime if DATABASE_URL absent.
 *
 * Fixture strategy: bypass @/characters/persist (pre-existing merge-conflict
 * markers in src/characters/derive.ts block vite transform — tracked in
 * .planning/phases/03-migration-cutover/deferred-items.md). Use raw SQL for
 * the user + character insert so the test is self-contained and survives the
 * sibling-plan merge state.
 */

const HAS_DB = !!process.env.DATABASE_URL;

const TEST_USER = 'user_dwd_' + Date.now();
let SESSION_ID = '';
let CAMPAIGN_ID = '';
let CHAR_ID = '';

(HAS_DB ? describe : describe.skip)('dual_write_divergences table', () => {
  beforeAll(async () => {
    // User row — minimal required fields. The users table only requires `id`.
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    // Character row — raw SQL to avoid pulling in the (currently broken)
    // saveCharacter pipeline. Provide every NOT NULL column with a sensible
    // default. The character itself is never inspected by this suite — it
    // exists purely to satisfy the sessions.character_id FK.
    const charResult = await db.execute(sql`
      insert into characters (
        user_id, name, race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size
      ) values (
        ${TEST_USER}, 'Divergence Subject', 'human', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 10 })}::jsonb,
        2, 12, 14, 30,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 10
      )
      returning id
    `);
    CHAR_ID = (charResult.rows[0] as { id: string }).id;

    // Campaign + session via drizzle (these tables are not in conflict).
    const [campaign] = await db
      .insert(campaigns)
      .values({ userId: TEST_USER, name: 'DWD test campaign', premise: 'x' })
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
    // Cascade delete via sessions → divergences also works, but explicit
    // cleanup is safer against pooled prod connections.
    await db.execute(sql`delete from dual_write_divergences where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('insert + select round-trip', async () => {
    const [row] = await db
      .insert(dualWriteDivergences)
      .values({
        sessionId: SESSION_ID,
        campaignId: CAMPAIGN_ID,
        characterId: CHAR_ID,
        eventType: 'hp_change',
        vaultState: { hp_current: 20 },
        postgresState: { hp_current: 15 },
        summary: 'hp_current vault=20 postgres=15',
      })
      .returning();

    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row!.sessionId).toBe(SESSION_ID);
    expect(row!.campaignId).toBe(CAMPAIGN_ID);
    expect(row!.characterId).toBe(CHAR_ID);
    expect(row!.eventType).toBe('hp_change');
    expect(row!.vaultState).toEqual({ hp_current: 20 });
    expect(row!.postgresState).toEqual({ hp_current: 15 });
    expect(row!.summary).toBe('hp_current vault=20 postgres=15');
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it('(session_id, created_at DESC) index exists', async () => {
    // Postgres-specific introspection — proves the migration ran the
    // CREATE INDEX step and not just CREATE TABLE.
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'dual_write_divergences'
        AND indexname = 'dual_write_divergences_session_idx';
    `);
    expect(result.rows ?? []).toHaveLength(1);
  });

  it('SELECT ordering by created_at DESC works (operator query)', async () => {
    // Insert 3 rows with small time gaps; query latest first.
    // Use a fresh session_id to isolate from the first test's row.
    const [otherSession] = await db
      .insert(sessions)
      .values({
        userId: TEST_USER,
        characterId: CHAR_ID,
        campaignId: CAMPAIGN_ID,
        premise: 'ordering-test',
      })
      .returning();
    const orderingSessionId = otherSession!.id;

    for (let i = 0; i < 3; i++) {
      await db.insert(dualWriteDivergences).values({
        sessionId: orderingSessionId,
        campaignId: CAMPAIGN_ID,
        eventType: `test_${i}`,
        summary: `t${i}`,
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    const rows = await db
      .select()
      .from(dualWriteDivergences)
      .where(eq(dualWriteDivergences.sessionId, orderingSessionId))
      .orderBy(desc(dualWriteDivergences.createdAt))
      .limit(3);

    expect(rows).toHaveLength(3);
    expect(rows[0]!.summary).toBe('t2');
    expect(rows[1]!.summary).toBe('t1');
    expect(rows[2]!.summary).toBe('t0');

    // Cleanup the ordering session's rows + the session itself
    await db.execute(sql`delete from dual_write_divergences where session_id = ${orderingSessionId}`);
    await db.execute(sql`delete from sessions where id = ${orderingSessionId}`);
  });

  it('character_id is nullable (session-level divergences)', async () => {
    const [row] = await db
      .insert(dualWriteDivergences)
      .values({
        sessionId: SESSION_ID,
        campaignId: CAMPAIGN_ID,
        characterId: null,
        eventType: 'session_level',
        summary: 'session-level divergence',
      })
      .returning();
    expect(row!.characterId).toBeNull();
    expect(row!.eventType).toBe('session_level');
  });
});
