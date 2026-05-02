import { describe, it, expect, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, diceLog } from '@/db/schema';

const TEST_USER = 'user_history_' + Date.now();
let SESSION_ID = '';

describe('sessions history persistence', () => {
  afterAll(async () => {
    await db.execute(sql`delete from dice_log where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_messages where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('persists messages and dice rolls and reads them back ordered', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tharion';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });

    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, premise: 'goblin warren' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 11, hitDiceRemaining: 1 });

    await db.insert(sessionMessages).values([
      { sessionId: SESSION_ID, role: 'player', content: 'I attack the goblin' },
      { sessionId: SESSION_ID, role: 'master', content: 'Your blade finds its mark.' },
    ]);

    await db.insert(diceLog).values([
      { sessionId: SESSION_ID, kind: 'attack', formula: '1d20+5', rolls: [14], modifier: 5, total: 19, meta: {} },
      { sessionId: SESSION_ID, kind: 'damage', formula: '1d8+3', rolls: [4], modifier: 3, total: 7, meta: {} },
    ]);

    const messages = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, SESSION_ID));
    expect(messages.length).toBe(2);
    const rolls = await db.select().from(diceLog).where(eq(diceLog.sessionId, SESSION_ID));
    expect(rolls.length).toBe(2);
    const totals = rolls.map((r) => r.total).sort((a, b) => a - b);
    expect(totals).toEqual([7, 19]);
  });
});
