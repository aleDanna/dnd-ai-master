import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db, pool } from '@/db/client';
import { users, campaigns } from '@/db/schema';
import { POST as postInvite, GET as listInvites } from '@/app/api/campaigns/[id]/invites/route';

const HOST = 'user_mp_host_001';
const GUEST = 'user_mp_guest_001';
let CURRENT_USER = HOST;

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: CURRENT_USER }),
}));

let campaignId: string;

beforeAll(async () => {
  await db.insert(users).values([
    { id: HOST, displayName: 'Host' },
    { id: GUEST, displayName: 'Guest' },
  ]).onConflictDoNothing();
  const [c] = await db.insert(campaigns).values({
    userId: HOST,
    name: 'MP Test',
    premise: 'A test multiplayer campaign.',
  }).returning();
  campaignId = c!.id;
});

afterAll(async () => {
  // Delete campaigns first (cascades to campaign_invites), then users
  await db.execute(`DELETE FROM campaigns WHERE user_id = '${HOST}'`);
  await db.execute(`DELETE FROM users WHERE id IN ('${HOST}', '${GUEST}')`);
  await pool.end();
});

describe('POST /api/campaigns/[id]/invites', () => {
  it('host creates an invite', async () => {
    CURRENT_USER = HOST;
    const req = new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) });
    const res = await postInvite(req as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invite.token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(body.url).toContain(body.invite.token);
  });

  it('guest gets 403', async () => {
    CURRENT_USER = GUEST;
    const req = new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) });
    const res = await postInvite(req as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(403);
  });

  it('rejects expiresAt in the past', async () => {
    CURRENT_USER = HOST;
    const req = new Request('http://test/api', {
      method: 'POST',
      body: JSON.stringify({ expiresAt: '2020-01-01T00:00:00Z' }),
    });
    const res = await postInvite(req as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/campaigns/[id]/invites', () => {
  it('host lists active invites', async () => {
    CURRENT_USER = HOST;
    const res = await listInvites(new Request('http://test/api') as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.invites)).toBe(true);
    expect(body.invites.length).toBeGreaterThan(0);
  });
});
