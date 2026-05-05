import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql, eq, asc } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import {
  sessions,
  sessionState,
  sessionMessages,
  sessionChapters,
  codexEntities,
} from '@/db/schema';
import { extractMemory, __setExtractorProviderForTest } from '@/sessions/memory/extractor';
import type { MasterProvider, CompleteMessageOutput } from '@/ai/provider/types';

const TEST_USER = 'user_extr_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';

function fakeProvider(jsonReply: string): MasterProvider {
  return {
    name: 'anthropic',
    completeMessage: async (): Promise<CompleteMessageOutput> => ({
      contentBlocks: [{ type: 'text', text: jsonReply }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
    detectLanguage: async () => null,
    proposeWizard: async () => ({
      toolInput: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  };
}

async function freshSession(): Promise<void> {
  const [s] = await db
    .insert(sessions)
    .values({ userId: TEST_USER, characterId: CHAR_ID, premise: 'x' })
    .returning();
  SESSION_ID = s!.id;
  await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
}

async function seedMessages(count: number): Promise<void> {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      sessionId: SESSION_ID,
      role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
      content: `message ${i}`,
    });
  }
  await db.insert(sessionMessages).values(rows);
}

describe('extractMemory', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    CHAR_ID = c.id;
  });

  beforeEach(async () => {
    await freshSession();
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
    __setExtractorProviderForTest(null);
  });

  it('light mode: with <40 new messages, runs LIGHT and applies upserts only', async () => {
    await seedMessages(4);
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [
            {
              kind: 'npc',
              slug: 'aldric',
              name: 'Aldric',
              data: { description: 'wizard', status: 'alive', disposition: 'ally', tags: [] },
            },
          ],
        }),
      ),
    );

    await extractMemory(SESSION_ID);

    const npcs = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(npcs).toHaveLength(1);
    expect(npcs[0]!.slug).toBe('aldric');
    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapters).toHaveLength(0);
  });

  it('full mode: with 40+ new messages, runs FULL, creates chapter 0', async () => {
    await seedMessages(40);
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [
            {
              kind: 'location',
              slug: 'silver-tavern',
              name: 'Silver Tavern',
              data: { description: 'cozy', tags: ['inn'] },
            },
          ],
          chapterSummary: 'The first chapter, in which the hero entered the Silver Tavern.',
        }),
      ),
    );

    await extractMemory(SESSION_ID);

    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID))
      .orderBy(asc(sessionChapters.chapterIndex));
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.chapterIndex).toBe(0);
    expect(chapters[0]!.messageCount).toBe(40);
    expect(chapters[0]!.summary).toContain('Silver Tavern');
    const locs = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(locs).toHaveLength(1);
  });

  it('full mode: 80 messages -> two chapters (sequential runs)', async () => {
    await seedMessages(80);
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [],
          chapterSummary: 'A chapter happened.',
        }),
      ),
    );

    await extractMemory(SESSION_ID); // chapter 0
    await extractMemory(SESSION_ID); // chapter 1

    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID))
      .orderBy(asc(sessionChapters.chapterIndex));
    expect(chapters.map((c) => c.chapterIndex)).toEqual([0, 1]);
  });

  it('OOC messages are excluded from chapter ranges', async () => {
    // 35 normal + 10 OOC + 5 normal => 40 non-OOC, threshold reached
    const rows: { sessionId: string; role: 'player' | 'master'; content: string }[] = [];
    for (let i = 0; i < 35; i++) {
      rows.push({ sessionId: SESSION_ID, role: i % 2 === 0 ? 'player' : 'master', content: 'msg' });
    }
    for (let i = 0; i < 10; i++) {
      rows.push({ sessionId: SESSION_ID, role: 'player', content: '!ooc question' });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({ sessionId: SESSION_ID, role: 'master', content: 'msg' });
    }
    await db.insert(sessionMessages).values(rows);

    __setExtractorProviderForTest(
      fakeProvider(JSON.stringify({ upserts: [], chapterSummary: 'OOC test chapter.' })),
    );
    await extractMemory(SESSION_ID);

    const [chapter] = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapter!.messageCount).toBe(40);
  });

  it('malformed JSON: extractor logs and does not throw', async () => {
    await seedMessages(2);
    __setExtractorProviderForTest(fakeProvider('not json at all'));
    await expect(extractMemory(SESSION_ID)).resolves.toBeUndefined();
    const npcs = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(npcs).toHaveLength(0);
  });
});
