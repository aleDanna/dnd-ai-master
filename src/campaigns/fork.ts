import { eq, and, isNull } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { characters } from '@/db/schema';
import { abilityModifier } from '@/engine/modifiers';
import { deriveLevel1Spellcasting } from '@/characters/derive';

type Tx = typeof db | PgTransaction<any, any, any>;

export type ForkResult = { instanceId: string; hpMax: number; hitDiceMax: number };

/**
 * Deep-copy a character template into a campaign-bound instance.
 * All mutable fields reset to fresh-L1 state; identity / abilities /
 * race / class / background are preserved from the template.
 *
 * Throws `Error('not-a-template')` if the passed character is already an
 * instance (templateId NOT NULL). Re-binding an existing instance to a new
 * campaign would silently contaminate the old campaign's character — the API
 * contract requires passing a template (templateId IS NULL).
 */
export async function forkTemplateForCampaign(opts: {
  tx: Tx;
  userId: string;
  characterId: string;
  campaignId: string;
}): Promise<ForkResult> {
  const { tx, userId, characterId, campaignId } = opts;

  const [template] = await tx
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId), isNull(characters.deletedAt)))
    .limit(1);
  if (!template) throw new Error('character-not-found');

  if (template.templateId) {
    // Reject instance ids: re-binding an instance to a new campaign would
    // silently change its `campaignId`, contaminating the old campaign's
    // character. The API contract is "pass a template (templateId IS NULL)".
    throw new Error('not-a-template');
  }

  const conMod = abilityModifier(template.abilities.CON);
  const dexMod = abilityModifier(template.abilities.DEX);
  const freshHpMax = template.hitDieSize + conMod;
  const freshAc = 10 + dexMod;
  const freshSpellcasting = deriveLevel1Spellcasting(template.classSlug, template.abilities, 2);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _ignore, createdAt: _c, updatedAt: _u, ...templateData } = template;
  const [instance] = await tx
    .insert(characters)
    .values({
      ...templateData,
      templateId: template.id,
      campaignId,
      // ── Reset progression / state to L1 fresh ──
      level: 1,
      xp: 0,
      proficiencyBonus: 2,
      hpMax: freshHpMax,
      ac: freshAc,
      hitDiceMax: 1,
      classes: [{ slug: template.classSlug, level: 1 }],
      spellcasting: freshSpellcasting,
      spellsKnown: freshSpellcasting?.spellsKnown ?? [],
      features: [],
      inventory: [],
      // ── Reset Phase 4-14 fields ──
      inspiration: false,
      attunedItems: [],
      senses: null,
      equippedFocus: null,
      craftingProjects: [],
      downtimeActivities: [],
      hirelings: [],
      bastion: null,
      deletedAt: null,
      mountedOn: null,
      embarkedOn: null,
    })
    .returning();
  if (!instance) throw new Error('fork-failed');

  return { instanceId: instance.id, hpMax: freshHpMax, hitDiceMax: 1 };
}
