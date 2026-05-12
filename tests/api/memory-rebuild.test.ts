import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, sessionChapters, campaigns } from '@/db/schema';
import { __setExtractorProviderForTest } from '@/sessions/memory/extractor';

const TEST_USER = 'user_rebuild_' + Date.now();
let SESSION_ID = '';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: TEST_USER }),
}));

async function readSse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { event: string; data: unknown }[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const ev = p.match(/^event: (.+)$/m)?.[1];
      const data = p.match(/^data: (.+)$/m)?.[1];
      if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
    }
  }
  return events;
}

describe('POST /api/sessions/:id/memory/rebuild', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [camp] = await db
      .insert(campaigns)
      .values({ userId: TEST_USER, name: 'Test Campaign', premise: 'x' })
      .returning();
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: c.id, premise: 'x', campaignId: camp!.id })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
    // 80 non-OOC messages → 2 chapters expected.
    const rows = [];
    for (let i = 0; i < 80; i++) {
      rows.push({
        sessionId: SESSION_ID,
        role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
        content: `m${i}`,
      });
    }
    await db.insert(sessionMessages).values(rows);

    __setExtractorProviderForTest({
      name: 'anthropic',
      detectLanguage: async () => null,
      proposeWizard: async () => ({
        toolInput: {},
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
      completeMessage: async () => ({
        contentBlocks: [
          { type: 'text', text: JSON.stringify({ upserts: [], chapterSummary: 'fake summary' }) },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    });
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
    __setExtractorProviderForTest(null);
  });

  it('produces chapters and SSE progress events', async () => {
    const { POST } = await import('@/app/api/sessions/[id]/memory/rebuild/route');
    const req = new Request(`http://localhost/api/sessions/${SESSION_ID}/memory/rebuild`, {
      method: 'POST',
    });
    const res = await POST(req as never, { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(res);
    const kinds = events.map((e) => e.event);
    expect(kinds.filter((k) => k === 'chapter_done').length).toBe(2);
    expect(kinds[kinds.length - 1]).toBe('complete');

    const chapters = await db.select().from(sessionChapters).where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapters).toHaveLength(2);
  });
});
