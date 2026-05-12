// src/multiplayer/access.ts
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters, sessions } from '@/db/schema';

/**
 * Returns true if `userId` is allowed to subscribe to/read session events:
 * either owns a non-deleted instance character in the campaign, or is the
 * campaign's host.
 */
export async function checkPartyAccess(userId: string, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ campaignUserId: campaigns.userId, campaignId: campaigns.id })
    .from(sessions)
    .innerJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return false;

  if (row.campaignUserId === userId) return true;  // host

  const [member] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(
      eq(characters.campaignId, row.campaignId),
      eq(characters.userId, userId),
      isNotNull(characters.templateId),
      isNull(characters.deletedAt),
    ))
    .limit(1);
  return !!member;
}
