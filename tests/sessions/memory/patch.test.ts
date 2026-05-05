import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import {
  sessions,
  sessionState,
  sessionMessages,
  codexEntities,
  sessionChapters,
} from '@/db/schema';
import { applyPatch } from '@/sessions/memory/patch';

const TEST_USER = 'user_patch_' + Date.now();
let SESSION_ID = '';
let MSG_A = '';
let MSG_B = '';

describe('applyPatch', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: charId, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
    const [a] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'player', content: 'hello' })
      .returning();
    const [b] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'master', content: 'You meet Aldric.' })
      .returning();
    MSG_A = a!.id;
    MSG_B = b!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('inserts a new NPC entity on first upsert', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'npc',
          slug: 'aldric',
          name: 'Aldric',
          data: {
            description: 'Old wizard with a long beard.',
            status: 'alive',
            disposition: 'ally',
            tags: ['mentor'],
          },
        },
      ],
      lastSeenMsgId: MSG_B,
    });

    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.kind, 'npc')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe('aldric');
    expect(rows[0]!.name).toBe('Aldric');
    expect(rows[0]!.lastSeenMsgId).toBe(MSG_B);
  });

  it('is idempotent: re-applying the same patch does not duplicate', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'npc',
          slug: 'aldric',
          name: 'Aldric',
          data: {
            description: 'Old wizard with a long beard.',
            status: 'alive',
            disposition: 'ally',
            tags: ['mentor'],
          },
        },
      ],
      lastSeenMsgId: MSG_B,
    });

    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.kind, 'npc')));
    expect(rows).toHaveLength(1);
  });

  it('updates name + data on conflict', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'npc',
          slug: 'aldric',
          name: 'Aldric the Grey',
          data: {
            description: 'Updated description.',
            status: 'alive',
            disposition: 'ally',
            tags: ['mentor', 'archmage'],
          },
        },
      ],
      lastSeenMsgId: MSG_A,
    });

    const [row] = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'aldric')));
    expect(row!.name).toBe('Aldric the Grey');
    expect((row!.data as { description: string }).description).toBe('Updated description.');
    // lastSeenMsgId moves to the most recent we passed
    expect(row!.lastSeenMsgId).toBe(MSG_A);
  });

  it('inserts a chapter row when patch includes chapter', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [],
      chapter: {
        chapterIndex: 0,
        firstMsgId: MSG_A,
        lastMsgId: MSG_B,
        messageCount: 2,
        summary: 'A first encounter.',
      },
      lastSeenMsgId: MSG_B,
    });

    const rows = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chapterIndex).toBe(0);
    expect(rows[0]!.summary).toBe('A first encounter.');
  });

  it('rolls back on invalid kind/data shape', async () => {
    const before = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    await expect(
      applyPatch(SESSION_ID, {
        upserts: [
          // npc requires status/disposition/tags — missing here on purpose
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { kind: 'npc', slug: 'broken', name: 'Broken', data: { description: 'x' } as any },
        ],
        lastSeenMsgId: MSG_B,
      }),
    ).rejects.toThrow();
    const after = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(after.length).toBe(before.length);
  });

  it('inserts a non-NPC kind (location) on a happy-path call', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'location',
          slug: 'silver-tavern',
          name: 'Silver Tavern',
          data: { description: 'Cozy inn at the crossroads.', tags: ['inn', 'town'] },
        },
      ],
      lastSeenMsgId: MSG_B,
    });
    const [row] = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.kind, 'location')));
    expect(row!.slug).toBe('silver-tavern');
    expect((row!.data as { description: string }).description).toContain('Cozy inn');
  });

  it('rejects empty description string with patch_invalid error', async () => {
    await expect(
      applyPatch(SESSION_ID, {
        upserts: [
          {
            kind: 'location',
            slug: 'empty-loc',
            name: 'Empty',
            data: { description: '', tags: [] },
          },
        ],
        lastSeenMsgId: MSG_B,
      }),
    ).rejects.toThrow(/patch_invalid:location:description/);
  });

  it('chapter insert is idempotent on (session_id, chapter_index)', async () => {
    // Already inserted chapter 0 in earlier test. Re-running with the same
    // chapterIndex must NOT duplicate — onConflictDoNothing protects us.
    await applyPatch(SESSION_ID, {
      upserts: [],
      chapter: {
        chapterIndex: 0,
        firstMsgId: MSG_A,
        lastMsgId: MSG_B,
        messageCount: 2,
        summary: 'Different summary that should be ignored.',
      },
      lastSeenMsgId: MSG_B,
    });
    const rows = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(rows).toHaveLength(1);
    // The original summary is preserved.
    expect(rows[0]!.summary).toBe('A first encounter.');
  });
});
