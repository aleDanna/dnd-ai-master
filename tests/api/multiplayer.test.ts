import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionState } from '@/db/schema';
import { POST as postInvite, GET as listInvites } from '@/app/api/campaigns/[id]/invites/route';
import { DELETE as deleteInvite } from '@/app/api/campaigns/[id]/invites/[inviteId]/route';
import { GET as resolveToken } from '@/app/api/r/[token]/route';
import { POST as joinCampaign } from '@/app/api/campaigns/[id]/join/route';

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

  // Create a host template character
  const [hostTemplate] = await db.insert(characters).values({
    userId: HOST, name: 'Tharion',
    raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 11, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
    templateId: null, campaignId: null,
  }).returning();

  // Fork the template into an instance bound to the campaign
  const { id: _tid, createdAt: _tc, updatedAt: _tu, ...templateData } = hostTemplate!;
  const [hostInstance] = await db.insert(characters).values({
    ...templateData,
    templateId: hostTemplate!.id,
    campaignId: campaignId,
  }).returning();

  // Create the host's session so guests have a session to join
  const [hostSession] = await db.insert(sessions).values({
    userId: HOST,
    characterId: hostInstance!.id,
    campaignId: campaignId,
    premise: 'A test multiplayer campaign.',
    currentPlayerCharacterId: hostInstance!.id,
  }).returning();

  await db.insert(sessionState).values({
    sessionId: hostSession!.id,
    hpCurrent: 12,
    hitDiceRemaining: 1,
  });
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

describe('DELETE /api/campaigns/[id]/invites/[inviteId]', () => {
  it('host revokes an invite', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    const res = await deleteInvite(
      new Request('http://test/api', { method: 'DELETE' }) as any,
      { params: Promise.resolve({ id: campaignId, inviteId: invite.id }) },
    );
    expect(res.status).toBe(204);
  });

  it('guest gets 403', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    CURRENT_USER = GUEST;
    const res = await deleteInvite(
      new Request('http://test/api', { method: 'DELETE' }) as any,
      { params: Promise.resolve({ id: campaignId, inviteId: invite.id }) },
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /api/r/[token]', () => {
  it('valid token returns campaign info', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    const res = await resolveToken(
      new Request('http://test/api') as any,
      { params: Promise.resolve({ token: invite.token }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaignId).toBe(campaignId);
    expect(body.campaignName).toBe('MP Test');
  });

  it('unknown token returns 410', async () => {
    const res = await resolveToken(
      new Request('http://test/api') as any,
      { params: Promise.resolve({ token: 'nonexistent_' }) },
    );
    expect(res.status).toBe(410);
  });

  it('revoked token returns 410', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    await deleteInvite(
      new Request('http://test/api', { method: 'DELETE' }) as any,
      { params: Promise.resolve({ id: campaignId, inviteId: invite.id }) },
    );
    const res = await resolveToken(
      new Request('http://test/api') as any,
      { params: Promise.resolve({ token: invite.token }) },
    );
    expect(res.status).toBe(410);
  });
});

describe('POST /api/campaigns/[id]/join', () => {
  let guestTemplateId: string;
  beforeAll(async () => {
    const [tpl] = await db.insert(characters).values({
      userId: GUEST, name: 'Lyra',
      raceSlug: 'tiefling', classSlug: 'cleric', backgroundSlug: 'acolyte',
      classes: [{ slug: 'cleric', level: 1 }],
      abilities: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 16, CHA: 14 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 10, ac: 14, speed: 30, hitDieSize: 8, hitDiceMax: 1,
      proficiencies: { saves: ['WIS', 'CHA'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [],
      identity: { alignment: 'N' },
    }).returning();
    guestTemplateId = tpl!.id;
  });

  it('guest joins via valid token', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();

    CURRENT_USER = GUEST;
    const res = await joinCampaign(
      new Request('http://test/api', {
        method: 'POST',
        body: JSON.stringify({ token: invite.token, characterTemplateId: guestTemplateId }),
      }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
  });

  it('joining twice returns 409', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://test/api', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();

    CURRENT_USER = GUEST;
    const res = await joinCampaign(
      new Request('http://test/api', {
        method: 'POST',
        body: JSON.stringify({ token: invite.token, characterTemplateId: guestTemplateId }),
      }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    expect(res.status).toBe(409);
  });

  it('rejects invalid token with 410', async () => {
    CURRENT_USER = GUEST;
    const res = await joinCampaign(
      new Request('http://test/api', {
        method: 'POST',
        body: JSON.stringify({ token: 'nonexistent_', characterTemplateId: guestTemplateId }),
      }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    expect(res.status).toBe(410);
  });
});
