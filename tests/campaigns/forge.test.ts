import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters, sessions, sessionState, users } from '@/db/schema';
import { createCampaign } from '@/campaigns/forge';

describe('createCampaign', () => {
  const userId = 'user_forge_test_' + Math.random().toString(36).slice(2);
  let templateId: string;

  beforeEach(async () => {
    await db.insert(users).values({ id: userId, displayName: 'Forge Test' }).onConflictDoNothing();
    const [tpl] = await db.insert(characters).values({
      userId, name: 'Tharion', level: 1, xp: 0,
      raceSlug: 'half-elf', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 15, DEX: 14, CON: 13, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 11, ac: 16, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [],
      identity: { alignment: 'N', backstory: '' },
    }).returning();
    templateId = tpl!.id;
  });

  it('creates campaign + instance + session + session_state atomically', async () => {
    const result = await createCampaign({
      userId, name: 'Goblin Warren', premise: 'A cramped warren beneath an old mill.',
      characterTemplateId: templateId,
    });

    expect(result.campaign.name).toBe('Goblin Warren');
    expect(result.sessionId).toBeDefined();

    const [instance] = await db.select().from(characters).where(eq(characters.templateId, templateId));
    expect(instance).toBeDefined();
    expect(instance!.campaignId).toBe(result.campaign.id);

    const [session] = await db.select().from(sessions).where(eq(sessions.campaignId, result.campaign.id));
    expect(session).toBeDefined();
    expect(session!.characterId).toBe(instance!.id);

    const [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, session!.id));
    expect(state).toBeDefined();
  });

  it('rejects a template owned by a different user', async () => {
    await expect(
      createCampaign({ userId: 'someone-else', name: 'X', premise: 'Y', characterTemplateId: templateId })
    ).rejects.toThrow(/character-forbidden/);
  });

  it('snapshots the creator\'s preferences into campaigns.settings, dropping ttsAutoplay', async () => {
    // Set non-default global preferences on the creator before forging.
    await db.update(users).set({
      preferences: {
        aiProvider: 'openai',
        aiMasterModel: 'gpt-5',
        narrationPace: 'brisk',
        manualRolls: true,
        ttsAutoplay: true,         // must NOT carry over — autoplay stays per-viewer
        ttsVoice: 'onyx',
      },
    }).where(eq(users.id, userId));

    const { campaign } = await createCampaign({
      userId, name: 'Snapshot test', premise: 'p',
      characterTemplateId: templateId,
    });

    expect(campaign.settings.aiProvider).toBe('openai');
    expect(campaign.settings.aiMasterModel).toBe('gpt-5');
    expect(campaign.settings.narrationPace).toBe('brisk');
    expect(campaign.settings.manualRolls).toBe(true);
    expect(campaign.settings.ttsVoice).toBe('onyx');
    expect('ttsAutoplay' in campaign.settings).toBe(false);
  });
});
