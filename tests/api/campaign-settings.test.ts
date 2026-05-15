import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters } from '@/db/schema';
import { NextRequest } from 'next/server';

const HOST = 'user_camp_api_host_' + Date.now();
const MEMBER = 'user_camp_api_member_' + Date.now();
const STRANGER = 'user_camp_api_stranger_' + Date.now();

let CALLER: string = HOST;
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: CALLER })),
}));

import { GET, PUT } from '@/app/api/campaigns/[id]/settings/route';

function getReq(): NextRequest {
  return new NextRequest('http://localhost/api/campaigns/x/settings', { method: 'GET' });
}
function putReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/campaigns/x/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET/PUT /api/campaigns/[id]/settings', () => {
  let campaignId: string;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: HOST, displayName: 'H', preferences: {} },
      { id: MEMBER, displayName: 'M', preferences: {} },
      { id: STRANGER, displayName: 'S', preferences: {} },
    ]).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'API Test', premise: 'p',
      settings: { narrationPace: 'detailed' },
    }).returning();
    campaignId = c!.id;
    // MEMBER joins by having an instance character in the campaign
    const [tpl] = await db.insert(characters).values({
      userId: MEMBER, name: 'M-tpl', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    }).returning();
    await db.insert(characters).values({
      userId: MEMBER, name: 'M-inst', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId,
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${HOST}, ${MEMBER}, ${STRANGER})`);
    await pool.end();
  });

  it('GET as host returns settings + canEdit:true', async () => {
    CALLER = HOST;
    const res = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEdit).toBe(true);
    expect(body.settings.narrationPace).toBe('detailed');
  });

  it('GET as member returns settings + canEdit:false', async () => {
    CALLER = MEMBER;
    const res = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEdit).toBe(false);
    expect(body.settings.narrationPace).toBe('detailed');
  });

  it('GET as stranger returns 403', async () => {
    CALLER = STRANGER;
    const res = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(403);
  });

  it('PUT as host updates and returns the resolved settings', async () => {
    CALLER = HOST;
    const res = await PUT(putReq({ narrationPace: 'brisk' }), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.narrationPace).toBe('brisk');
  });

  it('PUT as non-host returns 403 and does not mutate', async () => {
    CALLER = MEMBER;
    const res = await PUT(putReq({ narrationPace: 'detailed' }), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(403);
    CALLER = HOST;
    const verify = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    const body = await verify.json();
    expect(body.settings.narrationPace).toBe('brisk'); // still the value the host set
  });

  it('PUT with invalid provider returns 400', async () => {
    CALLER = HOST;
    const res = await PUT(putReq({ aiProvider: 'mistral' }), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-aiProvider');
  });
});
