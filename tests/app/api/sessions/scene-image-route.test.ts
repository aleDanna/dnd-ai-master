import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, campaigns } from '@/db/schema';
import { GET } from '@/app/api/sessions/[id]/scene-image/route';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({ userId: 'user_route_si' }),
}));

const TEST_USER = 'user_route_si';
let SESSION_ID = '';

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/sessions/${SESSION_ID}/scene-image`, { headers });
}

describe('GET /api/sessions/[id]/scene-image', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tester';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [campaign] = await db.insert(campaigns).values({ userId: TEST_USER, name: 'Test campaign', premise: 'x' }).returning();
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, campaignId: campaign!.id, premise: 'x' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('returns 404 when version is 0', async () => {
    const res = await GET(makeReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 PNG with ETag matching the version when set', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await db.update(sessionState).set({ sceneImageData: bytes, sceneImagePrompt: 'p', sceneImageVersion: 7 }).where(eq(sessionState.sessionId, SESSION_ID));
    const res = await GET(makeReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('etag')).toBe('"v7"');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it('returns 304 when If-None-Match matches the current version', async () => {
    const res = await GET(makeReq({ 'if-none-match': '"v7"' }), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(304);
  });

  it('returns 403 when the session does not belong to the caller', async () => {
    const otherUser = 'user_route_si_other';
    await ensureUser(otherUser);
    const w = emptyWizardState();
    w.raceSlug = 'human'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Other';
    const { id: charId } = await saveCharacter({ userId: otherUser, wizard: w });
    const [otherCampaign] = await db.insert(campaigns).values({ userId: otherUser, name: 'Other campaign', premise: 'x' }).returning();
    const [s] = await db.insert(sessions).values({ userId: otherUser, characterId: charId, campaignId: otherCampaign!.id, premise: 'x' }).returning();
    const otherSessionId = s!.id;
    await db.insert(sessionState).values({ sessionId: otherSessionId, hpCurrent: 10, hitDiceRemaining: 1 });

    // Caller is still TEST_USER (mocked above); request the OTHER session.
    const res = await GET(makeReq(), { params: Promise.resolve({ id: otherSessionId }) });
    expect(res.status).toBe(403);

    // cleanup
    await db.execute(sql`delete from session_state where session_id = ${otherSessionId}`);
    await db.execute(sql`delete from sessions where id = ${otherSessionId}`);
    await db.execute(sql`delete from campaigns where user_id = ${otherUser}`);
    await db.execute(sql`delete from characters where user_id = ${otherUser}`);
    await db.execute(sql`delete from users where id = ${otherUser}`);
  });
});
