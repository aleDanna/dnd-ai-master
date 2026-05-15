import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { getCampaign } from '@/campaigns/persist';
import { getCampaignSettings } from '@/lib/preferences';
import { ensureUser } from '@/db/users';
import { CampaignSettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

export default async function CampaignSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  await ensureUser(userId);
  const { id } = await params;

  const data = await getCampaign(userId, id);
  if (!data) notFound();

  const settings = await getCampaignSettings(id);
  const canEdit = data.campaign.userId === userId;
  const activeSessionId = data.activeSession?.id ?? null;

  return (
    <CampaignSettingsClient
      campaignId={id}
      initialSettings={settings}
      canEdit={canEdit}
      activeSessionId={activeSessionId}
    />
  );
}
