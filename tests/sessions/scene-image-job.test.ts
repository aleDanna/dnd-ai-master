import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, campaigns } from '@/db/schema';
import { generateAndPersist, __setOpenAIClientForTest, __setGeminiClientForTest } from '@/sessions/scene-image-job';

const TEST_USER = 'user_sceneimg_' + Date.now();
let SESSION_ID = '';

describe('generateAndPersist', () => {
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

  // Each test sets the OpenAI client override; reset to null between tests so a
  // future case that forgets to set one doesn't silently inherit the previous
  // mock.
  afterEach(() => {
    __setOpenAIClientForTest(null);
  });

  it('on success: writes bytes + prompt + bumps version to expectedVersion', async () => {
    const fakeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // tiny "PNG" stub
    const fake = {
      images: {
        generate: vi.fn().mockResolvedValue({ data: [{ b64_json: fakeBytes.toString('base64') }] }),
      },
    };
    __setOpenAIClientForTest(fake as never);

    const result = await generateAndPersist(SESSION_ID, 'a tower', 'soft pastel', 1);

    expect(result).toEqual({ ok: true, version: 1 });
    const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
    expect(row!.sceneImageVersion).toBe(1);
    expect(row!.sceneImagePrompt).toBe('a tower');
    expect(row!.sceneImageData?.equals(fakeBytes)).toBe(true);
    expect(fake.images.generate).toHaveBeenCalledOnce();
  });

  it('on API failure: returns api_error and leaves the row unchanged', async () => {
    // Pre-state: row currently at version 1 from previous test.
    const fake = {
      images: {
        generate: vi.fn().mockRejectedValue(new Error('rate_limit')),
      },
    };
    __setOpenAIClientForTest(fake as never);

    const result = await generateAndPersist(SESSION_ID, 'something else', 'pastel', 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toContain('rate_limit');
    }

    const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
    // version is still 1, prompt still "a tower", bytes unchanged
    expect(row!.sceneImageVersion).toBe(1);
    expect(row!.sceneImagePrompt).toBe('a tower');
  });

  it('on stale expectedVersion: returns race_lost without overwriting newer state', async () => {
    // Force a newer version into the row (simulating a concurrent job that already finished).
    await db.update(sessionState).set({ sceneImageVersion: 5, sceneImagePrompt: 'newer' }).where(eq(sessionState.sessionId, SESSION_ID));
    const fake = {
      images: {
        generate: vi.fn().mockResolvedValue({ data: [{ b64_json: Buffer.from([0]).toString('base64') }] }),
      },
    };
    __setOpenAIClientForTest(fake as never);

    // Try to write expectedVersion=2 when the row is already at 5 — must be a no-op.
    const result = await generateAndPersist(SESSION_ID, 'stale', 'pastel', 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('race_lost');

    const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
    expect(row!.sceneImageVersion).toBe(5);
    expect(row!.sceneImagePrompt).toBe('newer');
  });

  it('on empty model response: returns empty_response and leaves the row unchanged', async () => {
    // Reset the row to a known state.
    await db.update(sessionState).set({ sceneImageVersion: 5, sceneImagePrompt: 'newer' }).where(eq(sessionState.sessionId, SESSION_ID));
    const fake = {
      images: { generate: vi.fn().mockResolvedValue({ data: [{}] }) },
    };
    __setOpenAIClientForTest(fake as never);

    const result = await generateAndPersist(SESSION_ID, 'empty', 'pastel', 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty_response');

    const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
    expect(row!.sceneImageVersion).toBe(5);
    expect(row!.sceneImagePrompt).toBe('newer');
  });

  it('dispatches to Gemini when provider="gemini"', async () => {
    // Reset the row to a known version (earlier tests left it at 5).
    await db.update(sessionState).set({ sceneImageVersion: 5, sceneImagePrompt: 'newer' }).where(eq(sessionState.sessionId, SESSION_ID));
    const fakeBytes = Buffer.from([0xab, 0xcd]);
    const fakeGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ inlineData: { mimeType: 'image/png', data: fakeBytes.toString('base64') } }],
              },
            },
          ],
        }),
        generateImages: vi.fn(),
      },
    };
    __setGeminiClientForTest(fakeGemini as never);
    try {
      const result = await generateAndPersist(SESSION_ID, 'a wizard', 'pastel', 6, 'gemini', 'gemini-2.5-flash-image');
      expect(result).toEqual({ ok: true, version: 6 });
      const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(row!.sceneImageVersion).toBe(6);
      expect(row!.sceneImageData?.equals(fakeBytes)).toBe(true);
      expect(fakeGemini.models.generateContent).toHaveBeenCalledOnce();
    } finally {
      __setGeminiClientForTest(null);
    }
  });
});
