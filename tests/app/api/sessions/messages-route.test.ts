import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionMessages, sessionState } from '@/db/schema';
import { GET } from '@/app/api/sessions/[id]/messages/route';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({ userId: 'user_msgs_route' }),
}));

const TEST_USER = 'user_msgs_route';
let SESSION_ID = '';

describe('GET /api/sessions/[id]/messages', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tester';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, premise: 'x' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from session_messages where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('returns the LATEST 200 messages (not the oldest) when the session has more than 200', async () => {
    // Insert 205 messages with strictly ascending timestamps so we can
    // verify which slice the route returns. The 205th is the newest.
    const base = Date.now();
    const inserts = Array.from({ length: 205 }, (_, i) => ({
      sessionId: SESSION_ID,
      role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
      content: `msg-${i.toString().padStart(3, '0')}`,
      createdAt: new Date(base + i * 1000),
    }));
    await db.insert(sessionMessages).values(inserts);

    const req = new Request(`http://localhost/api/sessions/${SESSION_ID}/messages`);
    const res = await GET(req as never, { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { content: string }[] };

    expect(body.messages.length).toBe(200);
    // Sliced to the latest 200: msg-005 .. msg-204
    expect(body.messages[0]!.content).toBe('msg-005');
    expect(body.messages[199]!.content).toBe('msg-204');
  });
});
