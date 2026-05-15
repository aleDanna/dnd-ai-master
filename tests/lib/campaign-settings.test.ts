import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { campaigns, users } from '@/db/schema';
import { getCampaignSettings, updateCampaignSettings, DEFAULT_PREFERENCES } from '@/lib/preferences';

const HOST = 'user_camp_settings_' + Date.now();

describe('getCampaignSettings — campaign-scoped resolution', () => {
  let campaignId: string;
  let emptyCampaignId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: HOST, displayName: 'Host', preferences: {} }).onConflictDoNothing();

    const [populated] = await db.insert(campaigns).values({
      userId: HOST, name: 'Populated', premise: 'p',
      settings: {
        aiProvider: 'openai',
        aiMasterModel: 'gpt-5',
        narrationPace: 'brisk',
        manualRolls: true,
      },
    }).returning();
    campaignId = populated!.id;

    const [empty] = await db.insert(campaigns).values({
      userId: HOST, name: 'Empty', premise: 'p',
    }).returning();
    emptyCampaignId = empty!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${HOST}`);
    await pool.end();
  });

  it('returns the stored settings with cascading defaults for missing keys', async () => {
    const s = await getCampaignSettings(campaignId);
    expect(s.aiProvider).toBe('openai');
    expect(s.aiMasterModel).toBe('gpt-5');
    expect(s.narrationPace).toBe('brisk');
    expect(s.manualRolls).toBe(true);
    // Unset keys fall back to defaults
    expect(s.masterGuidanceLevel).toBe(DEFAULT_PREFERENCES.masterGuidanceLevel);
    expect(s.showDifficultyNumbers).toBe(DEFAULT_PREFERENCES.showDifficultyNumbers);
  });

  it('returns full defaults when settings is empty {}', async () => {
    const s = await getCampaignSettings(emptyCampaignId);
    expect(s.narrationPace).toBe(DEFAULT_PREFERENCES.narrationPace);
    expect(s.manualRolls).toBe(DEFAULT_PREFERENCES.manualRolls);
  });

  it('throws on unknown / soft-deleted campaign id', async () => {
    await expect(getCampaignSettings('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/not found/);
  });

  it('updateCampaignSettings merges and persists', async () => {
    await updateCampaignSettings(emptyCampaignId, { narrationPace: 'brisk' });
    const s = await getCampaignSettings(emptyCampaignId);
    expect(s.narrationPace).toBe('brisk');

    await updateCampaignSettings(emptyCampaignId, { manualRolls: true });
    const s2 = await getCampaignSettings(emptyCampaignId);
    expect(s2.narrationPace).toBe('brisk'); // unchanged
    expect(s2.manualRolls).toBe(true);
  });
});
