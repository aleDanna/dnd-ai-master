import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, sessions, characters, type Campaign } from '@/db/schema';

export async function listCampaigns(userId: string, status?: 'active' | 'ended') {
  const conditions = [eq(campaigns.userId, userId), isNull(campaigns.deletedAt)];
  if (status) conditions.push(eq(campaigns.status, status));
  return db
    .select()
    .from(campaigns)
    .where(and(...conditions))
    .orderBy(desc(campaigns.lastPlayedAt), desc(campaigns.updatedAt));
}

export async function getCampaign(userId: string, campaignId: string) {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) return null;

  const [instance] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.campaignId, campaignId), isNull(characters.deletedAt)))
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
