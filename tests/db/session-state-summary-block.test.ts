import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { sessions, sessionState, campaigns } from '@/db/schema';

/**
 * Phase 03-B plan 03-B-03 — schema smoke for the per-turn summarization
 * persistence column (REQ-023).
 *
 * Cases:
 *   1. Existing rows have `summary_block = NULL` (default applies on insert).
 *   2. Round-trip `{text, generatedAt, tokensBefore}` JSONB write/read.
 *   3. Reset to NULL preserves the nullable contract (idempotent clear).
 *
 * Test pattern follows tests/db/dual-write-divergences.test.ts (sibling
 * plan 03-A-05): raw-SQL user/character bootstrap to bypass any in-flight
 * sibling-merge state in the saveCharacter pipeline; drizzle-native session
 * fixtures (sessions + session_state) since those tables are stable.
 *
 * Skips at runtime when DATABASE_URL is absent (CI without DB).
 */

const HAS_DB = !!process.env.DATABASE_URL;

const TEST_USER = 'user_ssb_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';

(HAS_DB ? describe : describe.skip)('session_state.summaryBlock', () => {
  beforeAll(async () => {
    // User row — only `id` is required.
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    // Character row via raw SQL to be self-contained against any in-flight
    // sibling-plan merge state. The character is never inspected by this
    // suite — it exists purely to satisfy the sessions.character_id FK.
    const charResult = await db.execute(sql`
      insert into characters (
        user_id, name, race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size
      ) values (
        ${TEST_USER}, 'Summary Subject', 'human', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 10 })}::jsonb,
        2, 12, 14, 30,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 10
      )
      returning id
    `);
    CHAR_ID = (charResult.rows[0] as { id: string }).id;

    // Campaign + session via drizzle (stable tables). Campaign FK is the
    // only consumer of the row — no further inspection needed.
    const [campaign] = await db
      .insert(campaigns)
      .values({ userId: TEST_USER, name: 'SSB test campaign', premise: 'x' })
      .returning();

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

    // Insert the session_state row WITHOUT providing summaryBlock — the
    // default null behavior is what case 1 verifies.
    await db.insert(sessionState).values({
      sessionId: SESSION_ID,
      hpCurrent: 12,
      hitDiceRemaining: 1,
    });
  });

  afterAll(async () => {
    // sessions.onDelete cascade clears session_state automatically, but
    // explicit cleanup is safer against pooled prod connections.
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('defaults to null on new rows', async () => {
    const [row] = await db
      .select({ summaryBlock: sessionState.summaryBlock })
      .from(sessionState)
      .where(eq(sessionState.sessionId, SESSION_ID))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.summaryBlock).toBeNull();
  });

  it('round-trip {text, generatedAt, tokensBefore}', async () => {
    const block = {
      text: 'Aragorn entered the dungeon and parleyed with the troll.',
      generatedAt: '2026-05-26T12:00:00Z',
      tokensBefore: 15234,
    };

    await db
      .update(sessionState)
      .set({ summaryBlock: block })
      .where(eq(sessionState.sessionId, SESSION_ID));

    const [row] = await db
      .select({ summaryBlock: sessionState.summaryBlock })
      .from(sessionState)
      .where(eq(sessionState.sessionId, SESSION_ID))
      .limit(1);

    expect(row).toBeDefined();
    expect(row!.summaryBlock).toEqual(block);
    // Field-by-field for clearer diagnostics if the equality fails.
    expect(row!.summaryBlock?.text).toBe(block.text);
    expect(row!.summaryBlock?.generatedAt).toBe(block.generatedAt);
    expect(row!.summaryBlock?.tokensBefore).toBe(block.tokensBefore);
  });

  it('reset to null', async () => {
    await db
      .update(sessionState)
      .set({ summaryBlock: null })
      .where(eq(sessionState.sessionId, SESSION_ID));

    const [row] = await db
      .select({ summaryBlock: sessionState.summaryBlock })
      .from(sessionState)
      .where(eq(sessionState.sessionId, SESSION_ID))
      .limit(1);

    expect(row).toBeDefined();
    expect(row!.summaryBlock).toBeNull();
  });
});
