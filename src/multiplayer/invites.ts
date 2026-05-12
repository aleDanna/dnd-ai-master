import { and, eq, isNull, sql, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaignInvites, type CampaignInvite } from '@/db/schema';
import { generateInviteToken, isInviteValid } from './token';

export type CreateInviteInput = {
  campaignId: string;
  createdByUserId: string;
  expiresAt?: Date | null;
  maxUses?: number | null;
};

export async function createInvite(input: CreateInviteInput): Promise<CampaignInvite> {
  // Token uniqueness retry loop (collision near-impossible with 12-char base64url).
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateInviteToken();
    try {
      const [row] = await db
        .insert(campaignInvites)
        .values({
          campaignId: input.campaignId,
          token,
          createdByUserId: input.createdByUserId,
          expiresAt: input.expiresAt ?? null,
          maxUses: input.maxUses ?? null,
        })
        .returning();
      if (!row) throw new Error('invite-insert-failed');
      return row;
    } catch (err) {
      if (attempt === 4) throw err;
      // Retry on token collision
    }
  }
  throw new Error('invite-create-exhausted-retries');
}

/** List active (non-revoked, non-expired, non-maxed) invites for a campaign. */
export async function listActiveInvites(campaignId: string): Promise<CampaignInvite[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(campaignInvites)
    .where(and(
      eq(campaignInvites.campaignId, campaignId),
      isNull(campaignInvites.revokedAt),
    ))
    .orderBy(desc(campaignInvites.createdAt));
  return rows.filter((r) => isInviteValid(r, now));
}

export async function revokeInvite(inviteId: string, campaignId: string): Promise<boolean> {
  const [row] = await db
    .update(campaignInvites)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(campaignInvites.id, inviteId),
      eq(campaignInvites.campaignId, campaignId),
      isNull(campaignInvites.revokedAt),
    ))
    .returning({ id: campaignInvites.id });
  return !!row;
}

/** Resolve a token. Returns null if not found / not valid. */
export async function resolveToken(token: string): Promise<CampaignInvite | null> {
  const [row] = await db
    .select()
    .from(campaignInvites)
    .where(eq(campaignInvites.token, token))
    .limit(1);
  if (!row) return null;
  if (!isInviteValid(row)) return null;
  return row;
}

/** Atomic increment of uses_count (used by the join flow). */
export async function incrementInviteUses(inviteId: string): Promise<void> {
  await db
    .update(campaignInvites)
    .set({ usesCount: sql`uses_count + 1` })
    .where(eq(campaignInvites.id, inviteId));
}
