import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionMessages, sessionState } from '@/db/schema';
import { NextRequest } from 'next/server';

const HOST = 'user_img_coalesce_' + Date.now();
let CALLER = HOST;

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: CALLER })),
}));

let generateCalls = 0;
vi.mock('@/sessions/image-providers/openai', () => ({
  generateBytesOpenAI: vi.fn(async () => {
    generateCalls += 1;
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, bytes: Buffer.from('FAKE_PNG') };
  }),
  __setOpenAIClientForTest: () => {},
}));
vi.mock('@/sessions/image-providers/gemini', () => ({
  generateBytesGemini: vi.fn(),
  __setGeminiClientForTest: () => {},
}));

import { POST } from '@/app/api/sessions/[id]/messages/[messageId]/scene-image/route';

function postReq(): NextRequest {
  return new NextRequest('http://localhost/api/sessions/x/messages/y/scene-image', { method: 'POST' });
}

describe('POST /scene-image coalesces concurrent calls', () => {
  let sessionId: string;
  let messageId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: HOST, displayName: 'H' }).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'C', premise: 'p',
      settings: { imageGenerationEnabled: true, imageProvider: 'openai', imageStylePreset: 'pastel' },
    }).returning();
    const [tpl] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    }).returning();
    const [inst] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId: c!.id,
    }).returning();
    const [s] = await db.insert(sessions).values({
      userId: HOST, characterId: inst!.id, campaignId: c!.id, premise: 'p',
      currentPlayerCharacterId: inst!.id,
    }).returning();
    sessionId = s!.id;
    await db.insert(sessionState).values({ sessionId, hpCurrent: 12, hitDiceRemaining: 1 });
    const [m] = await db.insert(sessionMessages).values({
      sessionId, role: 'master', content: 'A torchlit hall stretches ahead.',
    }).returning();
    messageId = m!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${HOST}`);
    await pool.end();
  });

  it('only calls the image provider once for two concurrent requests', async () => {
    const params = { params: Promise.resolve({ id: sessionId, messageId }) };
    const [r1, r2] = await Promise.all([POST(postReq(), params), POST(postReq(), params)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(generateCalls).toBe(1);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.version).toBe(1);
    expect(j2.version).toBe(1);
  });
});
