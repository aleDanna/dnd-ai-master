import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionMessages, sessionState, ttsCache } from '@/db/schema';
import { tryClaimTtsJob, tryClaimImageJob } from '@/sessions/job-claims';

const USER = 'user_job_claims_' + Date.now();
let campaignId: string;
let sessionId: string;
let messageId: string;

const VOICE = 'onyx';
const MODEL = 'gpt-4o-mini-tts';
const PROVIDER = 'openai';

// Shared setup/teardown for the whole file — pool must stay open across both
// describe blocks; sessionId is used by tryClaimImageJob tests too.
beforeAll(async () => {
  await db.insert(users).values({ id: USER, displayName: 'U' }).onConflictDoNothing();
  const [c] = await db.insert(campaigns).values({ userId: USER, name: 'JC', premise: 'p' }).returning();
  campaignId = c!.id;
  const [tpl] = await db.insert(characters).values({
    userId: USER, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
  }).returning();
  const [inst] = await db.insert(characters).values({
    userId: USER, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    templateId: tpl!.id, campaignId,
  }).returning();
  const [s] = await db.insert(sessions).values({
    userId: USER, characterId: inst!.id, campaignId, premise: 'p',
    currentPlayerCharacterId: inst!.id,
  }).returning();
  sessionId = s!.id;
  await db.insert(sessionState).values({ sessionId, hpCurrent: 12, hitDiceRemaining: 1 });
  const [m] = await db.insert(sessionMessages).values({
    sessionId, role: 'master', content: 'Once upon a time…',
  }).returning();
  messageId = m!.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER}`);
  await pool.end();
});

describe('tryClaimTtsJob', () => {
  beforeEach(async () => {
    await db.delete(ttsCache);
  });

  it('first caller becomes the leader (empty cache)', async () => {
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('leader');
    const [row] = await db.select().from(ttsCache).limit(1);
    expect(row?.status).toBe('pending');
    expect(row?.audioMp3).toBeNull();
  });

  it('second caller becomes follower while first is pending', async () => {
    await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    const res2 = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res2.result).toBe('follower');
  });

  it('returns ready when cache is hot', async () => {
    await db.insert(ttsCache).values({
      messageId, voice: VOICE, model: MODEL, provider: PROVIDER,
      status: 'ready', audioMp3: Buffer.from('audio-bytes'), mimeType: 'audio/mpeg',
    });
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('ready');
    if (res.result !== 'ready') throw new Error('expected ready');
    expect(res.existing.audioMp3?.toString()).toBe('audio-bytes');
  });

  it('re-claims a stale pending row (>60s old)', async () => {
    await db.insert(ttsCache).values({
      messageId, voice: VOICE, model: MODEL, provider: PROVIDER,
      status: 'pending', startedAt: new Date(Date.now() - 90_000),
    });
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('leader');
    const [row] = await db.select().from(ttsCache).limit(1);
    expect(row?.status).toBe('pending');
    expect(row!.startedAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('re-claims a failed row', async () => {
    await db.insert(ttsCache).values({
      messageId, voice: VOICE, model: MODEL, provider: PROVIDER,
      status: 'failed', failedReason: 'rate_limit',
      startedAt: new Date(Date.now() - 5_000),
    });
    const res = await tryClaimTtsJob(messageId, VOICE, MODEL, PROVIDER);
    expect(res.result).toBe('leader');
    const [row] = await db.select().from(ttsCache).limit(1);
    expect(row?.status).toBe('pending');
    expect(row?.failedReason).toBeNull();
  });
});

describe('tryClaimImageJob', () => {
  beforeEach(async () => {
    // Reset session_state image fields so each test starts from a clean slate.
    await db.update(sessionState)
      .set({ sceneImagePending: false, sceneImagePendingAt: null, sceneImageFailedReason: null })
      .where(sql`session_id = ${sessionId}`);
  });

  it('first caller becomes leader (pending=false initially)', async () => {
    await db.update(sessionState).set({ sceneImagePending: false, sceneImagePendingAt: null, sceneImageFailedReason: null }).where(sql`session_id = ${sessionId}`);
    const res = await tryClaimImageJob(sessionId);
    expect(res.isLeader).toBe(true);
    const [row] = await db.select().from(sessionState).where(sql`session_id = ${sessionId}`).limit(1);
    expect(row?.sceneImagePending).toBe(true);
  });

  it('second caller is a follower while pending', async () => {
    await tryClaimImageJob(sessionId);
    const res2 = await tryClaimImageJob(sessionId);
    expect(res2.isLeader).toBe(false);
  });

  it('re-claims a stale pending (>60s old)', async () => {
    await db.update(sessionState).set({
      sceneImagePending: true,
      sceneImagePendingAt: new Date(Date.now() - 90_000),
    }).where(sql`session_id = ${sessionId}`);
    const res = await tryClaimImageJob(sessionId);
    expect(res.isLeader).toBe(true);
  });

  it('re-claims when a previous attempt failed', async () => {
    await db.update(sessionState).set({
      sceneImagePending: false,
      sceneImagePendingAt: new Date(Date.now() - 5_000),
      sceneImageFailedReason: 'api_error',
    }).where(sql`session_id = ${sessionId}`);
    const res = await tryClaimImageJob(sessionId);
    expect(res.isLeader).toBe(true);
  });
});
