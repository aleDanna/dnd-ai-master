import { auth } from '@clerk/nextjs/server';
import { redirect, notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters } from '@/db/schema';
import { resolveToken } from '@/multiplayer/invites';
import { JoinClient } from './join-client';
import { ExpiredInviteCard } from '@/components/multiplayer/expired-invite-card';

export const dynamic = 'force-dynamic';

export default async function JoinCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { userId } = await auth();
  const { id: campaignId } = await params;
  const { token } = await searchParams;

  if (!userId) {
    const here = `/campaigns/${campaignId}/join${token ? `?token=${token}` : ''}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }

  if (!token) notFound();

  const invite = await resolveToken(token);
  if (!invite || invite.campaignId !== campaignId) return <ExpiredInviteCard />;

  const [campaign] = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) return <ExpiredInviteCard />;

  const templates = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.userId, userId),
      isNull(characters.templateId),
      isNull(characters.deletedAt),
    ));

  if (templates.length === 0) {
    redirect(`/characters/new?returnTo=${encodeURIComponent(`/campaigns/${campaignId}/join?token=${token}`)}`);
  }

  return (
    <JoinClient
      campaignId={campaignId}
      campaignName={campaign.name}
      token={token}
      templates={templates.map((t) => ({
        id: t.id, name: t.name, raceSlug: t.raceSlug, classSlug: t.classSlug, level: t.level,
      }))}
    />
  );
}
