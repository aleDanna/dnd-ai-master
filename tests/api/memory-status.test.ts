import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, sessionChapters } from '@/db/schema';

const TEST_USER = 'user_memstatus_' + Date.now();
let SESSION_ID = '';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: TEST_USER }),
}));

async function call(): Promise<{ status: number; json: unknown }> {
  const { GET } = await import('@/app/api/sessions/[id]/memory/status/route');
  const req = new Request(`http://localhost/api/sessions/${SESSION_ID}/memory/status`);
  const res = await GET(req as never, { params: Promise.resolve({ id: SESSION_ID }) });
  return { status: res.status, json: await res.json() };
}

describe('GET /api/sessions/:id/memory/status', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: c.id, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('reports messageCount=0, chapterCount=0, needsBackfill=false on empty', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ messageCount: 0, chapterCount: 0, needsBackfill: false });
  });

  it('needsBackfill=true when 40+ messages and 0 chapters', async () => {
    const rows = [];
    for (let i = 0; i < 42; i++) {
      rows.push({
        sessionId: SESSION_ID,
        role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
        content: 'm',
      });
    }
    await db.insert(sessionMessages).values(rows);

    const r = await call();
    expect(r.json).toMatchObject({ messageCount: 42, chapterCount: 0, needsBackfill: true });
  });

  it('OOC messages excluded from messageCount', async () => {
    await db.execute(sql`delete from session_messages where session_id = ${SESSION_ID}`);
    await db.insert(sessionMessages).values([
      { sessionId: SESSION_ID, role: 'player', content: 'normal' },
      { sessionId: SESSION_ID, role: 'player', content: '!ooc' },
    ]);
    const r = await call();
    expect(r.json).toMatchObject({ messageCount: 1 });
  });

  it('needsBackfill=false once a chapter exists', async () => {
    const [m1] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'player', content: 'a' })
      .returning();
    await db.insert(sessionChapters).values({
      sessionId: SESSION_ID,
      chapterIndex: 0,
      firstMsgId: m1!.id,
      lastMsgId: m1!.id,
      messageCount: 1,
      summary: 's',
    });
    // Add 50 more messages to push messageCount above 40 again.
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push({
        sessionId: SESSION_ID,
        role: 'player' as const,
        content: 'm',
      });
    }
    await db.insert(sessionMessages).values(rows);

    const r = await call();
    expect(r.json).toMatchObject({ chapterCount: 1, needsBackfill: false });
  });
});
