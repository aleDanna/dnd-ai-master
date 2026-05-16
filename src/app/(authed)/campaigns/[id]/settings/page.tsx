import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { getCampaign } from '@/campaigns/persist';
import { getCampaignSettings } from '@/lib/preferences';
import { fetchLocalServicesStatus } from '@/lib/local-services';
import { ensureUser } from '@/db/users';
import { CampaignSettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

export default async function CampaignSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ first?: string; session?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  await ensureUser(userId);
  const { id } = await params;
  const { first, session } = await searchParams;

  const data = await getCampaign(userId, id);
  if (!data) notFound();

  const [settings, localServices] = await Promise.all([
    getCampaignSettings(id),
    fetchLocalServicesStatus(),
  ]);
  const canEdit = data.campaign.userId === userId;
  const activeSessionId = data.activeSession?.id ?? null;
  // First-run detour from /campaigns/new — show CTA banner + Start button.
  // Honour `?session=...` if present (newly-created session); else fall back
  // to the active session for the campaign (also covers refresh-with-?first=1).
  const firstRunSessionId = first === '1' ? (session ?? activeSessionId) : null;

  return (
    <CampaignSettingsClient
      campaignId={id}
      initialSettings={settings}
      canEdit={canEdit}
      activeSessionId={activeSessionId}
      localServices={localServices}
      firstRunSessionId={firstRunSessionId}
    />
  );
}
