import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { sessions, aiUsage } from '@/db/schema';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { checkQuotas, DAILY_TURN_CAP } from '@/ai/master/quotas';

const TEST_USER = 'user_quota_' + Date.now();

describe('checkQuotas', () => {
  afterAll(async () => {
    await db.execute(sql`delete from ai_usage where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('passes when user has no usage and no sessions', async () => {
    await ensureUser(TEST_USER);
    const r = await checkQuotas({ userId: TEST_USER });
    expect(r.ok).toBe(true);
  });

  it('rejects when daily turn cap is reached', async () => {
    await ensureUser(TEST_USER);
    // Insert one row past the configured cap (env-overridable since
    // 2026-05-03 — the test must respect DAILY_TURN_CAP rather than a
    // hardcoded 200).
    const inserts = Array.from({ length: DAILY_TURN_CAP + 1 }, () => ({
      userId: TEST_USER,
      endpoint: 'master' as const,
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 100,
      outputTokens: 50,
    }));
    await db.insert(aiUsage).values(inserts);
    const r = await checkQuotas({ userId: TEST_USER });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_turn_cap');
  });

  it('rejects creation when 50 active sessions exist', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'X';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const sessionInserts = Array.from({ length: 51 }, () => ({ userId: TEST_USER, characterId: charId, premise: 'p' }));
    await db.insert(sessions).values(sessionInserts);
    const r = await checkQuotas({ userId: TEST_USER, kind: 'create_session' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('session_count_cap');
  });
});
