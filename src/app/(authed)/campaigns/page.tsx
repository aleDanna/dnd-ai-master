import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns as campaignsTable, characters as charactersTable } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CampaignCard } from '@/components/campaigns/campaign-card';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const rows = await db
    .select({ campaign: campaignsTable, character: charactersTable })
    .from(campaignsTable)
    .leftJoin(charactersTable, eq(charactersTable.campaignId, campaignsTable.id))
    .where(and(eq(campaignsTable.userId, userId), isNull(campaignsTable.deletedAt)));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Campaigns</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15 }}>
            {rows.length === 0 ? 'No campaigns yet — begin a new tale.' : `${rows.length} campaigns.`}
          </p>
        </div>
        <Link href="/campaigns/new">
          <Button variant="primary" size="md" icon="plus">New campaign</Button>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {rows.map(({ campaign, character }) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            characterName={character?.name}
            characterRace={character?.raceSlug}
            characterClass={character?.classSlug}
            characterLevel={character?.level}
          />
        ))}
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
