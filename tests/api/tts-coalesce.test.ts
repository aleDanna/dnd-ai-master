import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionMessages, sessionState, ttsCache } from '@/db/schema';
import { NextRequest } from 'next/server';

const HOST = 'user_tts_coalesce_' + Date.now();
let CALLER = HOST;
let synthCalls = 0;

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: CALLER })),
}));

vi.mock('@/ai/tts', () => ({
  synthesizeSpeech: vi.fn(async () => {
    synthCalls += 1;
    // Slow enough that two concurrent calls both observe pending state.
    await new Promise((r) => setTimeout(r, 150));
    return { bytes: new TextEncoder().encode('FAKE_AUDIO').buffer, mimeType: 'audio/mpeg' };
  }),
}));

import { GET } from '@/app/api/sessions/[id]/messages/[messageId]/tts/route';

function getReq(): NextRequest {
  return new NextRequest('http://localhost/api/sessions/x/messages/y/tts', { method: 'GET' });
}

describe('GET /tts coalesces concurrent calls', () => {
  let sessionId: string;
  let messageId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: HOST, displayName: 'H' }).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'C', premise: 'p',
      settings: { ttsProvider: 'openai', ttsVoice: 'onyx', ttsModel: 'gpt-4o-mini-tts' },
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
      sessionId, role: 'master', content: 'Once upon a time…',
    }).returning();
    messageId = m!.id;
  });

  beforeEach(async () => {
    await db.delete(ttsCache);
    synthCalls = 0;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${HOST}`);
    await pool.end();
  });

  it('only calls the provider once for two concurrent requests', async () => {
    const params = { params: Promise.resolve({ id: sessionId, messageId }) };
    const [r1, r2] = await Promise.all([GET(getReq(), params), GET(getReq(), params)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(synthCalls).toBe(1);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    const b2 = new Uint8Array(await r2.arrayBuffer());
    expect(new TextDecoder().decode(b1)).toBe('FAKE_AUDIO');
    expect(new TextDecoder().decode(b2)).toBe('FAKE_AUDIO');
  });

  it('a third request after completion hits the cache (no extra synth call)', async () => {
    const params = { params: Promise.resolve({ id: sessionId, messageId }) };
    await GET(getReq(), params);
    expect(synthCalls).toBe(1);
    await GET(getReq(), params);
    expect(synthCalls).toBe(1);
  });
});
