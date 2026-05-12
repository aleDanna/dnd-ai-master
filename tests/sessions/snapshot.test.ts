import { describe, it, expect, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, combatActors, characters, campaigns } from '@/db/schema';
import { buildSnapshot } from '@/sessions/snapshot';

const TEST_USER = 'user_snap_' + Date.now();

/** Create a minimal campaign for test fixtures and return its id. */
async function makeTestCampaign(premise: string): Promise<string> {
  const [c] = await db
    .insert(campaigns)
    .values({ userId: TEST_USER, name: 'Test Campaign', premise })
    .returning();
  return c!.id;
}

describe('buildSnapshot', () => {
  afterAll(async () => {
    await db.execute(sql`delete from combat_actors where session_id in (select id from sessions where user_id = ${TEST_USER})`);
    await db.execute(sql`delete from session_state where session_id in (select id from sessions where user_id = ${TEST_USER})`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
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

    const campaignId = await makeTestCampaign('goblin warren');
    const [session] = await db.insert(sessions).values({ userId: TEST_USER, characterId, premise: 'goblin warren', campaignId }).returning();
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

  it('PHB §2.5: backfills classes[] from legacy classSlug+level when column is empty', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'wizard';
    w.backgroundSlug = 'sage';
    w.identity.name = 'LegacyMage';
    const { id: characterId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    // Force level 3 on the row, leave classes[] as the default empty array.
    await db.update(characters).set({ level: 3, classes: [] }).where(eq(characters.id, characterId));

    const campaignId = await makeTestCampaign('p');
    const [session] = await db.insert(sessions).values({ userId: TEST_USER, characterId, premise: 'p', campaignId }).returning();
    await db.insert(sessionState).values({ sessionId: session!.id, hpCurrent: 12, hitDiceRemaining: 3 });

    const snap = await buildSnapshot(session!.id, TEST_USER);
    const pc = snap.state.characters[0]!;
    expect(pc.classSlug).toBe('wizard');
    expect(pc.classes).toEqual([{ slug: 'wizard', level: 3 }]);
    expect(snap.characterMonoSpace).toContain('"classes":[{"slug":"wizard","level":3}]');
  });

  it('PHB §2.5: hydrates a multi-class breakdown when the column is populated', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Multi';
    const { id: characterId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    await db
      .update(characters)
      .set({
        level: 5,
        classes: [
          { slug: 'fighter', level: 3, subclass: 'eldritch-knight' },
          { slug: 'wizard', level: 2 },
        ],
      })
      .where(eq(characters.id, characterId));

    const campaignId = await makeTestCampaign('p');
    const [session] = await db.insert(sessions).values({ userId: TEST_USER, characterId, premise: 'p', campaignId }).returning();
    await db.insert(sessionState).values({ sessionId: session!.id, hpCurrent: 30, hitDiceRemaining: 5 });

    const snap = await buildSnapshot(session!.id, TEST_USER);
    const pc = snap.state.characters[0]!;
    expect(pc.classes).toEqual([
      { slug: 'fighter', level: 3, subclass: 'eldritch-knight' },
      { slug: 'wizard', level: 2 },
    ]);
    expect(pc.classSlug).toBe('fighter');
  });
});
