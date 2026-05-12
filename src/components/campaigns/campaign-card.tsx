import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import type { Campaign } from '@/db/schema';

export type CampaignCardData = {
  campaign: Campaign;
  characterName?: string | null;
  characterRace?: string | null;
  characterClass?: string | null;
  characterLevel?: number | null;
};

export function CampaignCard({ campaign, characterName, characterRace, characterClass, characterLevel }: CampaignCardData) {
  return (
    <Link href={`/campaigns/${campaign.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <Card accent={campaign.status === 'active'}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1.15 }}>
          {campaign.name}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          <Chip tone={campaign.status === 'active' ? 'accent' : 'neutral'} dot={campaign.status === 'active'}>
            {campaign.status}
          </Chip>
          {campaign.language && <Chip tone="gold">{campaign.language}</Chip>}
          <Chip tone="neutral">{campaign.style}</Chip>
        </div>
        {characterName && (
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-muted)' }}>
            {characterName} · {characterRace} {characterClass} L{characterLevel}
          </div>
        )}
        <div
          style={{
            marginTop: 10,
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          &ldquo;{campaign.premise}&rdquo;
        </div>
      </Card>
    </Link>
  );
}
