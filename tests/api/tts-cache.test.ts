import { describe, it, expect, afterAll } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, ttsCache, campaigns } from '@/db/schema';

const TEST_USER = 'user_tts_cache_' + Date.now();
let SESSION_ID = '';
let MESSAGE_ID = '';

describe('tts_cache persistence', () => {
  afterAll(async () => {
    if (MESSAGE_ID) {
      await db.execute(sql`delete from tts_cache where message_id = ${MESSAGE_ID}`);
    }
    if (SESSION_ID) {
      await db.execute(sql`delete from session_messages where session_id = ${SESSION_ID}`);
      await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    }
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('round-trips audio bytes for (message_id, voice) and dedupes via PK', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [campaign] = await db.insert(campaigns).values({ userId: TEST_USER, name: 'Test campaign', premise: 'goblin warren' }).returning();
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, campaignId: campaign!.id, premise: 'goblin warren' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 11, hitDiceRemaining: 1 });

    const [m] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'master', content: 'You see a dragon.' })
      .returning();
    MESSAGE_ID = m!.id;

    const fakeMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00]);

    // First insert: succeeds.
    await db.insert(ttsCache).values({ messageId: MESSAGE_ID, voice: 'onyx', audioMp3: fakeMp3, provider: 'openai' });

    const [hit] = await db
      .select()
      .from(ttsCache)
      .where(and(eq(ttsCache.messageId, MESSAGE_ID), eq(ttsCache.voice, 'onyx')))
      .limit(1);
    expect(hit).toBeDefined();
    expect(Buffer.compare(hit!.audioMp3, fakeMp3)).toBe(0);

    // Second insert with the same PK: no-op via onConflictDoNothing (would otherwise throw).
    await db
      .insert(ttsCache)
      .values({ messageId: MESSAGE_ID, voice: 'onyx', audioMp3: Buffer.from([0x01, 0x02]), provider: 'openai' })
      .onConflictDoNothing();

    // Original audio still there — second insert was suppressed.
    const [stillThere] = await db
      .select()
      .from(ttsCache)
      .where(and(eq(ttsCache.messageId, MESSAGE_ID), eq(ttsCache.voice, 'onyx')))
      .limit(1);
    expect(Buffer.compare(stillThere!.audioMp3, fakeMp3)).toBe(0);

    // A different voice for the same message gets its own row.
    await db.insert(ttsCache).values({ messageId: MESSAGE_ID, voice: 'nova', audioMp3: Buffer.from([0x77, 0x88]), provider: 'openai' });
    const allForMessage = await db.select().from(ttsCache).where(eq(ttsCache.messageId, MESSAGE_ID));
    expect(allForMessage.length).toBe(2);
    expect(allForMessage.map((r) => r.voice).sort()).toEqual(['nova', 'onyx']);
  });
});
