import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, codexEntities, sessionChapters } from '@/db/schema';
import { loadMemoryContext } from '@/sessions/memory/context';

const TEST_USER = 'user_ctx_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';
let MSG_ID = '';

describe('loadMemoryContext', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    CHAR_ID = c.id;
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: CHAR_ID, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
    const [m] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'player', content: 'I look for Aldric.' })
      .returning();
    MSG_ID = m!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('returns empty digests when nothing exists', async () => {
    const ctx = await loadMemoryContext(SESSION_ID, '');
    expect(ctx.chapterDigests).toBe('');
    expect(ctx.sceneCard).toContain('(no entities currently in scene)');
    expect(ctx.codexIndex).toContain('(empty codex)');
  });

  it('includes open quests in scene card always', async () => {
    await db.insert(codexEntities).values({
      sessionId: SESSION_ID,
      kind: 'quest',
      slug: 'find-aldric',
      name: 'Find Aldric',
      data: { description: 'Search the old wizard out.', status: 'open' },
    });
    const ctx = await loadMemoryContext(SESSION_ID, 'a generic scene');
    expect(ctx.sceneCard).toContain('Find Aldric');
  });

  it('matches NPC names by substring in player message / scene', async () => {
    await db.insert(codexEntities).values({
      sessionId: SESSION_ID,
      kind: 'npc',
      slug: 'aldric',
      name: 'Aldric',
      data: { description: 'wizard', status: 'alive', disposition: 'ally', tags: [] },
    });
    const ctx = await loadMemoryContext(SESSION_ID, 'a generic scene');
    expect(ctx.sceneCard).toContain('Aldric');
  });

  it('codexIndex lists all entities by kind', async () => {
    const ctx = await loadMemoryContext(SESSION_ID, '');
    expect(ctx.codexIndex).toContain('npcs:');
    expect(ctx.codexIndex).toContain('Aldric');
    expect(ctx.codexIndex).toContain('quests:');
    expect(ctx.codexIndex).toContain('Find Aldric');
  });

  it('chapterDigests concatenates summaries with chapter headers', async () => {
    await db.insert(sessionChapters).values({
      sessionId: SESSION_ID,
      chapterIndex: 0,
      firstMsgId: MSG_ID,
      lastMsgId: MSG_ID,
      messageCount: 1,
      summary: 'The hero began their journey.',
    });
    const ctx = await loadMemoryContext(SESSION_ID, '');
    expect(ctx.chapterDigests).toContain('## Chapter 0');
    expect(ctx.chapterDigests).toContain('The hero began their journey.');
  });

  it('scene card capped at 15 entries', async () => {
    for (let i = 0; i < 20; i++) {
      await db.insert(codexEntities).values({
        sessionId: SESSION_ID,
        kind: 'quest',
        slug: `q-${i}`,
        name: `Quest ${i}`,
        data: { description: 'x', status: 'open' },
      });
    }
    const ctx = await loadMemoryContext(SESSION_ID, '');
    const matches = ctx.sceneCard.match(/Quest \d+/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(15);
  });
});
