import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, combatActors } from '@/db/schema';
import { buildSnapshot } from '@/sessions/snapshot';

const TEST_USER = 'user_snap_' + Date.now();

describe('buildSnapshot', () => {
  afterAll(async () => {
    await db.execute(sql`delete from combat_actors where session_id in (select id from sessions where user_id = ${TEST_USER})`);
    await db.execute(sql`delete from session_state where session_id in (select id from sessions where user_id = ${TEST_USER})`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('builds an EngineState from a fresh session', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const { id: characterId } = await saveCharacter({ userId: TEST_USER, wizard: w });

    const [session] = await db.insert(sessions).values({ userId: TEST_USER, characterId, premise: 'goblin warren' }).returning();
    await db.insert(sessionState).values({ sessionId: session!.id, hpCurrent: 11, hitDiceRemaining: 1 });
    await db.insert(combatActors).values({ sessionId: session!.id, name: 'Goblin', monsterSlug: 'goblin', hpCurrent: 7, hpMax: 7 });

    const snap = await buildSnapshot(session!.id, TEST_USER);
    expect(snap.state.characters.length).toBe(1);
    expect(snap.state.characters[0]!.name).toBe('Tharion');
    expect(snap.state.combatActors.length).toBe(1);
    expect(snap.state.combatActors[0]!.name).toBe('Goblin');
    expect(snap.state.runtime[snap.state.characters[0]!.id]?.hpCurrent).toBe(11);
    expect(snap.scene).toBe('');
    expect(snap.characterMonoSpace).toContain('"name":"Tharion"');
  });

  it('throws if session does not belong to userId', async () => {
    await expect(buildSnapshot('00000000-0000-0000-0000-000000000000', TEST_USER)).rejects.toThrow();
  });
});
