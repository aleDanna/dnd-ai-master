import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, campaigns } from '@/db/schema';
import { GET } from '@/app/api/sessions/[id]/state/route';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({ userId: 'user_state_bytea' }),
}));

const TEST_USER = 'user_state_bytea';
let SESSION_ID = '';

describe('/state SSE excludes scene_image_data', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tester';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [campaign] = await db.insert(campaigns).values({ userId: TEST_USER, name: 'Test campaign', premise: 'x' }).returning();
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, campaignId: campaign!.id, premise: 'x' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({
      sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1,
      sceneImageData: Buffer.alloc(1024 * 1024, 0xff),
      sceneImagePrompt: 'big',
      sceneImageVersion: 3,
    });
  });

  afterAll(async () => {
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('does not include sceneImageData in the SSE payload, but does include version + prompt', async () => {
    const req = new NextRequest(`http://localhost/api/sessions/${SESSION_ID}/state`);
    const res = await GET(req, { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/event: snapshot/);
    expect(text).toMatch(/"sceneImageVersion":3/);
    expect(text).toMatch(/"sceneImagePrompt":"big"/);
    expect(text).not.toMatch(/sceneImageData/);
    // Cancel the stream so the test doesn't hang on the keepalive.
    await reader.cancel();
  }, 10_000);
});
