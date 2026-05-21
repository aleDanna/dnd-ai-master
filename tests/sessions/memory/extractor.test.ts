import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
  campaigns,
} from '@/db/schema';
import { extractMemory, __setExtractorProviderForTest } from '@/sessions/memory/extractor';
import type { MasterProvider, CompleteMessageOutput } from '@/ai/provider/types';

const TEST_USER = 'user_extr_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';
let CAMPAIGN_ID = '';

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
    .values({ userId: TEST_USER, characterId: CHAR_ID, premise: 'x', campaignId: CAMPAIGN_ID })
    .returning();
  SESSION_ID = s!.id;
  await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
}

async function seedMessages(count: number): Promise<void> {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const isPlayer = i % 2 === 0;
    rows.push({
      sessionId: SESSION_ID,
      role: (isPlayer ? 'player' : 'master') as 'player' | 'master',
      content: `message ${i}`,
      authorCharacterId: isPlayer ? CHAR_ID : null,
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
    const [camp] = await db
      .insert(campaigns)
      .values({ userId: TEST_USER, name: 'Test Campaign', premise: 'x' })
      .returning();
    CAMPAIGN_ID = camp!.id;
  });

  beforeEach(async () => {
    await freshSession();
  });

  afterEach(() => {
    __setExtractorProviderForTest(null);
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
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
    const rows: { sessionId: string; role: 'player' | 'master'; content: string; authorCharacterId: string | null }[] = [];
    for (let i = 0; i < 35; i++) {
      const isPlayer = i % 2 === 0;
      rows.push({ sessionId: SESSION_ID, role: isPlayer ? 'player' : 'master', content: 'msg', authorCharacterId: isPlayer ? CHAR_ID : null });
    }
    for (let i = 0; i < 10; i++) {
      rows.push({ sessionId: SESSION_ID, role: 'player', content: '!ooc question', authorCharacterId: CHAR_ID });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({ sessionId: SESSION_ID, role: 'master', content: 'msg', authorCharacterId: null });
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

  it('partial validity: invalid upserts are skipped, valid ones + chapter still apply', async () => {
    // Reproduction of session 621ea6c5 prod failure: dnd-master-max3 emitted a
    // `named_item` upsert without the required `magical` boolean. Previously
    // applyPatch failed-atomic on this and the chapter + valid NPCs were lost.
    await seedMessages(40);
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [
            // Valid NPC — must be persisted.
            {
              kind: 'npc',
              slug: 'aldric',
              name: 'Aldric',
              data: { description: 'wizard', status: 'alive', disposition: 'ally', tags: [] },
            },
            // Invalid named_item — missing `magical`. Must be skipped, not throw.
            {
              kind: 'named_item',
              slug: 'badge',
              name: 'Captains Badge',
              data: { description: 'A unique badge' },
            },
            // Valid location — must be persisted even though the named_item above is bad.
            {
              kind: 'location',
              slug: 'silver-tavern',
              name: 'Silver Tavern',
              data: { description: 'cozy', tags: ['inn'] },
            },
          ],
          chapterSummary: 'A chapter that includes a partly-malformed named_item.',
        }),
      ),
    );

    await extractMemory(SESSION_ID);

    const entities = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    const slugs = entities.map((e) => e.slug).sort();
    expect(slugs).toEqual(['aldric', 'silver-tavern']);

    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.summary).toContain('named_item');
  });
});
