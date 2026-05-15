import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  getSessionMasterPreferences,
  updateCampaignSettings,
} from '@/lib/preferences';
import { isImageStylePreset, isNarrationPace } from '@/db/schema/users';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions } from '@/db/schema';
import { sql } from 'drizzle-orm';

describe('image-generation preferences', () => {
  it('defaults to disabled with pastel preset and empty custom', () => {
    expect(DEFAULT_PREFERENCES.imageGenerationEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.imageStylePreset).toBe('pastel');
    expect(DEFAULT_PREFERENCES.imageStyleCustom).toBe('');
  });

  it('isImageStylePreset accepts the six allowed slugs and rejects others', () => {
    expect(isImageStylePreset('pastel')).toBe(true);
    expect(isImageStylePreset('watercolor')).toBe(true);
    expect(isImageStylePreset('oil')).toBe(true);
    expect(isImageStylePreset('ink')).toBe(true);
    expect(isImageStylePreset('photo')).toBe(true);
    expect(isImageStylePreset('custom')).toBe(true);
    expect(isImageStylePreset('anime')).toBe(false);
    expect(isImageStylePreset(42)).toBe(false);
    expect(isImageStylePreset(undefined)).toBe(false);
  });
});

describe('narrationPace preference', () => {
  it('defaults to "detailed" (current granular pacing)', () => {
    expect(DEFAULT_PREFERENCES.narrationPace).toBe('detailed');
  });

  it('isNarrationPace accepts the two allowed slugs and rejects others', () => {
    expect(isNarrationPace('detailed')).toBe(true);
    expect(isNarrationPace('brisk')).toBe(true);
    expect(isNarrationPace('fast')).toBe(false);
    expect(isNarrationPace('slow')).toBe(false);
    expect(isNarrationPace(true)).toBe(false);
    expect(isNarrationPace(undefined)).toBe(false);
  });
});

describe('getSessionMasterPreferences — campaign-scoped resolution', () => {
  const HOST = 'user_master_prefs_host';
  const GUEST = 'user_master_prefs_guest';
  let sessionId: string;
  let campaignId: string;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: HOST, displayName: 'Host', preferences: {} },
      { id: GUEST, displayName: 'Guest', preferences: {} },
    ]).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'Prefs Test', premise: 'p',
      settings: { aiProvider: 'anthropic', aiMasterModel: 'claude-sonnet-4-5' },
    }).returning();
    campaignId = c!.id;
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
    sessionId = s!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${HOST}, ${GUEST})`);
    await pool.end();
  });

  it('returns the campaign-stored AI provider regardless of which user asks', async () => {
    const prefs = await getSessionMasterPreferences(sessionId);
    expect(prefs.aiProvider).toBe('anthropic');
    expect(prefs.aiMasterModel).toBe('claude-sonnet-4-5');
  });

  it('reflects updates written to the campaign settings', async () => {
    await updateCampaignSettings(campaignId, { aiProvider: 'openai', aiMasterModel: 'gpt-5' });
    const prefs = await getSessionMasterPreferences(sessionId);
    expect(prefs.aiProvider).toBe('openai');
    expect(prefs.aiMasterModel).toBe('gpt-5');
  });

  it('throws on unknown / soft-deleted session id', async () => {
    await expect(getSessionMasterPreferences('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/not found/);
  });
});
