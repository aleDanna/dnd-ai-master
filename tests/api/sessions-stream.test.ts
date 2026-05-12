import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GET as streamRoute } from '@/app/api/sessions/[id]/stream/route';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionState } from '@/db/schema';

const HOST = 'user_stream_test_001';
let CURRENT_USER = HOST;

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: CURRENT_USER }),
}));

let sessionId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: HOST, displayName: 'Host' }).onConflictDoNothing();
  const [c] = await db.insert(campaigns).values({
    userId: HOST, name: 'Stream Test', premise: 'p',
  }).returning();
  const [tpl] = await db.insert(characters).values({
    userId: HOST, name: 'T',
    raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
  }).returning();
  const [inst] = await db.insert(characters).values({
    userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
    templateId: tpl!.id, campaignId: c!.id,
  }).returning();
  const [s] = await db.insert(sessions).values({
    userId: HOST, characterId: inst!.id, campaignId: c!.id, premise: 'p',
    currentPlayerCharacterId: inst!.id,
  }).returning();
  await db.insert(sessionState).values({ sessionId: s!.id, hpCurrent: 12, hitDiceRemaining: 1 });
  sessionId = s!.id;
});

afterAll(async () => {
  await db.execute(`DELETE FROM campaigns WHERE user_id = '${HOST}'`);
  await db.execute(`DELETE FROM users WHERE id = '${HOST}'`);
  await pool.end();
});

describe('GET /api/sessions/[id]/stream', () => {
  it('non-party user returns 403', async () => {
    CURRENT_USER = 'someone-else';
    const req = new Request('http://test/api');
    const res = await streamRoute(req as any, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(403);
  });

  it('party member returns 200 with text/event-stream', async () => {
    CURRENT_USER = HOST;
    const req = new Request('http://test/api', { signal: AbortSignal.timeout(100) });
    const res = await streamRoute(req as any, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
