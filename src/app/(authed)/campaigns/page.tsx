import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { and, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters as charactersTable } from '@/db/schema';
import { listCampaigns } from '@/campaigns/persist';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CampaignCard } from '@/components/campaigns/campaign-card';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const campaignRows = await listCampaigns(userId);

  const characterRows = campaignRows.length > 0
    ? await db
        .select()
        .from(charactersTable)
        .where(and(
          inArray(charactersTable.campaignId, campaignRows.map(c => c.id)),
          isNull(charactersTable.deletedAt),
        ))
    : [];

  const charactersByCampaign = new Map(characterRows.map(c => [c.campaignId, c]));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Campaigns</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15 }}>
            {campaignRows.length === 0 ? 'No campaigns yet — begin a new tale.' : `${campaignRows.length} campaigns.`}
          </p>
        </div>
        <Link href="/campaigns/new">
          <Button variant="primary" size="md" icon="plus">New campaign</Button>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {campaignRows.map((campaign) => {
          const character = charactersByCampaign.get(campaign.id);
          return (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              characterName={character?.name}
              characterRace={character?.raceSlug}
              characterClass={character?.classSlug}
              characterLevel={character?.level}
              // listCampaigns is already scoped to the viewer's owned rows.
              showDelete
            />
          );
        })}
        <Link href="/campaigns/new" style={{ textDecoration: 'none' }}>
          <button
            style={{
              width: '100%', background: 'transparent', border: '1px dashed var(--border-strong)',
              borderRadius: 8, padding: 18, minHeight: 200, color: 'var(--fg-muted)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer',
            }}
          >
            <Icon name="plus" size={24} />
            <span style={{ fontSize: 14 }}>Start a new campaign</span>
          </button>
        </Link>
      </div>
    </div>
  );
}
