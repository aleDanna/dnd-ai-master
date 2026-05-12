import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters, sessions, sessionState, type Campaign } from '@/db/schema';
import { forkTemplateForCampaign } from './fork';

export type CreateCampaignInput = {
  userId: string;
  name: string;
  premise: string;
  characterTemplateId: string;
};

export type CreateCampaignResult = { campaign: Campaign; sessionId: string };

/**
 * Atomic creation: campaign + character instance (fork from template) +
 * session + session_state. Any failure rolls back the entire transaction.
 *
 * During the PR1 → PR2 transition window the session row is double-written
 * with the deprecated long-lived columns so a rollback of the application
 * code can fall back to reading from `sessions.*` without data loss.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  return await db.transaction(async (tx) => {
    // Validate template ownership before any insert so FK violations on the
    // campaigns table don't mask the user-facing error.
    const [template] = await tx
      .select({ id: characters.id })
      .from(characters)
      .where(
        and(
          eq(characters.id, input.characterTemplateId),
          eq(characters.userId, input.userId),
          isNull(characters.deletedAt),
        ),
      )
      .limit(1);
    if (!template) throw new Error('character-not-found');

    const [campaign] = await tx
      .insert(campaigns)
      .values({
        userId: input.userId,
        name: input.name,
        premise: input.premise,
        // language / tonalFrame / engagementProfile keep their defaults; they will be set as the master interacts.
      })
      .returning();
    if (!campaign) throw new Error('campaign-insert-failed');

    const fork = await forkTemplateForCampaign({
      tx,
      userId: input.userId,
      characterId: input.characterTemplateId,
      campaignId: campaign.id,
    });

    const [session] = await tx
      .insert(sessions)
      .values({
        userId: input.userId,
        characterId: fork.instanceId,
        campaignId: campaign.id,
        // Deprecated double-write: PR2 drops these columns.
        premise: input.premise,
      })
      .returning();
    if (!session) throw new Error('session-insert-failed');

    await tx.insert(sessionState).values({
      sessionId: session.id,
      hpCurrent: fork.hpMax,
      hitDiceRemaining: fork.hitDiceMax,
    });

    return { campaign, sessionId: session.id };
  });
}
