import { redirect } from 'next/navigation';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns } from '@/db/schema';
import { resolveToken } from '@/multiplayer/invites';
import { ExpiredInviteCard } from '@/components/multiplayer/expired-invite-card';

export const dynamic = 'force-dynamic';

export default async function ResolveInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await resolveToken(token);
  if (!invite) return <ExpiredInviteCard />;
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, invite.campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) return <ExpiredInviteCard />;
  redirect(`/campaigns/${campaign.id}/join?token=${token}`);
}
