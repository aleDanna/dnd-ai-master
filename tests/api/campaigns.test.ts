import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { POST as postCampaign, GET as getCampaigns } from '@/app/api/campaigns/route';
import { GET as getOne, PATCH as patchOne, DELETE as delOne } from '@/app/api/campaigns/[id]/route';
import { db, pool } from '@/db/client';
import { characters, users } from '@/db/schema';

const OTHER_USER = 'user_campaigns_other_001';

const TEST_USER = 'user_campaigns_test_001';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: TEST_USER }),
}));

let templateId: string;
let otherUserTemplateId: string;
let instanceId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: TEST_USER, displayName: 'C Test' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER, displayName: 'Other User' }).onConflictDoNothing();

  const [tpl] = await db.insert(characters).values({
    userId: TEST_USER, name: 'Lyra',
    raceSlug: 'tiefling', classSlug: 'cleric', backgroundSlug: 'acolyte',
    classes: [{ slug: 'cleric', level: 1 }],
    abilities: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 16, CHA: 14 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 10, ac: 14, speed: 30, hitDieSize: 8, hitDiceMax: 1,
    proficiencies: { saves: ['WIS', 'CHA'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
  }).returning();
  templateId = tpl!.id;

  // A template owned by a different user (for forbidden test)
  const [otherTpl] = await db.insert(characters).values({
    userId: OTHER_USER, name: 'Zara',
    raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
  }).returning();
  otherUserTemplateId = otherTpl!.id;

  // Create an instance (character with templateId set) owned by TEST_USER (for not-a-template test)
  const [inst] = await db.insert(characters).values({
    userId: TEST_USER, name: 'Lyra Instance',
    raceSlug: 'tiefling', classSlug: 'cleric', backgroundSlug: 'acolyte',
    templateId: templateId,
    classes: [{ slug: 'cleric', level: 1 }],
    abilities: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 16, CHA: 14 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 10, ac: 14, speed: 30, hitDieSize: 8, hitDiceMax: 1,
    proficiencies: { saves: ['WIS', 'CHA'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
  }).returning();
  instanceId = inst!.id;
});

afterAll(async () => {
  await db.execute(sql`delete from session_state where session_id in (select id from sessions where user_id = ${TEST_USER})`);
  await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
  await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
  await db.execute(sql`delete from characters where user_id in (${TEST_USER}, ${OTHER_USER})`);
  await db.execute(sql`delete from users where id in (${TEST_USER}, ${OTHER_USER})`);
  await pool.end();
});

describe('POST /api/campaigns', () => {
  it('creates a campaign with valid body', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'My tale', premise: 'A goblin warren.', characterTemplateId: templateId }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.campaign.name).toBe('My tale');
    expect(body.sessionId).toBeTruthy();
  });

  it('returns 422 when premise is missing', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', characterTemplateId: templateId }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(422);
  });

  it('returns 404 when character does not exist', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: '00000000-0000-0000-0000-000000000000' }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('character-not-found');
  });

  it('returns 403 when character belongs to another user', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: otherUserTemplateId }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('character-forbidden');
  });

  it('returns 422 when characterTemplateId points to an instance (not a template)', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: instanceId }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('not-a-template');
  });
});

describe('GET /api/campaigns', () => {
  it('returns campaigns list', async () => {
    const req = new Request('http://test/api/campaigns');
    const res = await getCampaigns(req as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.campaigns)).toBe(true);
  });
});

describe('GET /api/campaigns/[id]', () => {
  it('returns campaign + character + activeSession', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await getOne(new Request('http://t') as any, { params: Promise.resolve({ id: campaign.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaign.id).toBe(campaign.id);
    expect(body.character).toBeTruthy();
    expect(body.activeSession).toBeTruthy();
  });
});

describe('PATCH /api/campaigns/[id]', () => {
  it('renames the campaign', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'Old', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await patchOne(
      new Request('http://t', { method: 'PATCH', body: JSON.stringify({ name: 'New' }) }) as any,
      { params: Promise.resolve({ id: campaign.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).campaign.name).toBe('New');
  });

  it('rejects premise mutations with 422', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await patchOne(
      new Request('http://t', { method: 'PATCH', body: JSON.stringify({ premise: 'changed' }) }) as any,
      { params: Promise.resolve({ id: campaign.id }) },
    );
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/campaigns/[id]', () => {
  it('soft-deletes campaign + session + instance', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await delOne(new Request('http://t') as any, { params: Promise.resolve({ id: campaign.id }) });
    expect(res.status).toBe(204);

    const after = await getOne(new Request('http://t') as any, { params: Promise.resolve({ id: campaign.id }) });
    expect(after.status).toBe(404);
  });
});
