import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, users } from '@/db/schema';
import { applyMutations } from '@/sessions/applicator';
import * as job from '@/sessions/scene-image-job';

// @vercel/functions exports waitUntil as non-configurable (CJS getter),
// so vi.spyOn can't reassign it. We hoist a vi.mock instead.
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

// Import after the mock is hoisted so we get the mocked module.
const vercelMod = await import('@vercel/functions');

const TEST_USER = 'user_app_si_' + Date.now();
let SESSION_ID = '';

describe('applyMutations queue_scene_image', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tester';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, premise: 'x' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(vercelMod.waitUntil).mockReset();
  });

  it('schedules generateAndPersist with the right args when image gen is enabled', async () => {
    await db.update(users).set({ preferences: { imageGenerationEnabled: true, imageStylePreset: 'pastel' } }).where(sql`id = ${TEST_USER}`);
    const spy = vi.spyOn(job, 'generateAndPersist').mockResolvedValue();
    const wuSpy = vi.mocked(vercelMod.waitUntil);

    await applyMutations(SESSION_ID, [{ op: 'queue_scene_image', visualPrompt: 'a goblin' }], []);

    expect(wuSpy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();
    const [sid, prompt, style, version] = spy.mock.calls[0]!;
    expect(sid).toBe(SESSION_ID);
    expect(prompt).toBe('a goblin');
    expect(style).toContain('pastel');
    expect(version).toBe(1);
  });

  it('passes the resolved custom style when preset is custom', async () => {
    await db.update(users).set({ preferences: { imageGenerationEnabled: true, imageStylePreset: 'custom', imageStyleCustom: 'low-poly 3d render' } }).where(sql`id = ${TEST_USER}`);
    const spy = vi.spyOn(job, 'generateAndPersist').mockResolvedValue();

    await applyMutations(SESSION_ID, [{ op: 'queue_scene_image', visualPrompt: 'a tavern' }], []);

    const [, , style] = spy.mock.calls[0]!;
    expect(style).toBe('low-poly 3d render');
  });

  it('no-ops when the user disabled image generation between tool register and apply', async () => {
    await db.update(users).set({ preferences: { imageGenerationEnabled: false } }).where(sql`id = ${TEST_USER}`);
    const spy = vi.spyOn(job, 'generateAndPersist').mockResolvedValue();
    const wuSpy = vi.mocked(vercelMod.waitUntil);

    await applyMutations(SESSION_ID, [{ op: 'queue_scene_image', visualPrompt: 'irrelevant' }], []);

    expect(wuSpy).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});
