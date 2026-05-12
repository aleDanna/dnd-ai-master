import { and, eq, isNull, isNotNull, desc, or, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, sessions, characters, type Campaign } from '@/db/schema';

/**
 * List every campaign the user is a party member of:
 *   - campaigns they host (`campaigns.userId === userId`), AND
 *   - campaigns they joined via invite (own a `characters` row with
 *     `templateId IS NOT NULL` + `campaignId = X` + `userId = me`).
 *
 * The two sets are merged at the application layer (rather than via a
 * UNION) so consumers always get distinct campaign rows with the standard
 * Drizzle shape — and so the host's row never appears twice for someone who
 * is both host and "joined" via the same character row.
 */
export async function listCampaigns(userId: string, status?: 'active' | 'ended') {
  // Campaigns where the viewer has an instance character — i.e. they joined
  // the party. We surface only campaign ids here; the full row is fetched
  // in the next query alongside the host's own campaigns.
  const joinedIds = (
    await db
      .selectDistinct({ id: characters.campaignId })
      .from(characters)
      .where(and(
        eq(characters.userId, userId),
        isNotNull(characters.templateId),
        isNotNull(characters.campaignId),
        isNull(characters.deletedAt),
      ))
  )
    .map((r) => r.id)
    .filter((id): id is string => id != null);

  const conditions = [
    isNull(campaigns.deletedAt),
    joinedIds.length > 0
      ? or(eq(campaigns.userId, userId), inArray(campaigns.id, joinedIds))
      : eq(campaigns.userId, userId),
  ];
  if (status) conditions.push(eq(campaigns.status, status));
  return db
    .select()
    .from(campaigns)
    .where(and(...conditions))
    .orderBy(desc(campaigns.lastPlayedAt), desc(campaigns.updatedAt));
}

/**
 * Returns whether the viewer is allowed to read the campaign — they're
 * either the host or hold an instance character inside the campaign's
 * party. Used by `getCampaign` and the `/campaigns/[id]` server component.
 */
async function userCanReadCampaign(userId: string, campaignId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: campaigns.userId })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!row) return false;
  if (row.userId === userId) return true;
  const [member] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(
      eq(characters.campaignId, campaignId),
      eq(characters.userId, userId),
      isNotNull(characters.templateId),
      isNull(characters.deletedAt),
    ))
    .limit(1);
  return !!member;
}

export async function getCampaign(userId: string, campaignId: string) {
  const canRead = await userCanReadCampaign(userId, campaignId);
  if (!canRead) return null;

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) return null;

  // The viewer's OWN instance character in the campaign (used by hub /
  // campaigns list as the "you play X" hint). Falls back to any instance
  // when the viewer is the host but has no instance yet (legacy data).
  const [instance] = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.campaignId, campaignId),
      eq(characters.userId, userId),
      isNotNull(characters.templateId),
      isNull(characters.deletedAt),
    ))
    .limit(1);

  const [activeSession] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  return { campaign, character: instance ?? null, activeSession: activeSession ?? null };
}

export async function renameCampaign(userId: string, campaignId: string, name: string): Promise<Campaign | null> {
  const [row] = await db
    .update(campaigns)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)))
    .returning();
  return row ?? null;
}

export async function softDeleteCampaign(userId: string, campaignId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(campaigns)
      .set({ deletedAt: now, status: 'ended', updatedAt: now })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)))
      .returning({ id: campaigns.id });
    if (!row) return false;

    await tx
      .update(sessions)
      .set({ deletedAt: now, updatedAt: now, status: 'ended' })
      .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)));

    await tx
      .update(characters)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(characters.campaignId, campaignId), isNull(characters.deletedAt)));

    return true;
  });
}

export async function touchCampaign(campaignId: string): Promise<void> {
  const now = new Date();
  await db.update(campaigns).set({ lastPlayedAt: now, updatedAt: now }).where(eq(campaigns.id, campaignId));
}
