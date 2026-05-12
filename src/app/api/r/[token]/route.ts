import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, users } from '@/db/schema';
import { resolveToken } from '@/multiplayer/invites';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const invite = await resolveToken(token);
  if (!invite) {
    return NextResponse.json({ error: 'invite-not-valid' }, { status: 410 });
  }
  const [campaign] = await db
    .select({ id: campaigns.id, name: campaigns.name, hostUserId: campaigns.userId })
    .from(campaigns)
    .where(and(eq(campaigns.id, invite.campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: 'campaign-deleted' }, { status: 410 });
  }
  const [host] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, campaign.hostUserId))
    .limit(1);
  return NextResponse.json({
    campaignId: campaign.id,
    campaignName: campaign.name,
    hostName: host?.displayName ?? 'Unknown host',
  });
}
