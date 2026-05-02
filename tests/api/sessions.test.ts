import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState } from '@/db/schema';

const TEST_USER = 'user_sess_' + Date.now();

describe('sessions persistence', () => {
  afterAll(async () => {
    await db.execute(sql`delete from session_state where session_id in (select id from sessions where user_id = ${TEST_USER})`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('inserts a session + session_state and reads them back', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tharion';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, premise: 'goblin warren' }).returning();
    expect(s).toBeDefined();
    await db.insert(sessionState).values({ sessionId: s!.id, hpCurrent: 11, hitDiceRemaining: 1 });
    const list = await db.select().from(sessions).where(sql`user_id = ${TEST_USER}`);
    expect(list.length).toBe(1);
  });
});
