import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { DeleteCardButton } from '@/components/ui/delete-card-button';
import type { Campaign } from '@/db/schema';

export type CampaignCardData = {
  campaign: Campaign;
  characterName?: string | null;
  characterRace?: string | null;
  characterClass?: string | null;
  characterLevel?: number | null;
  /**
   * When true, render the small "×" delete affordance in the card's top-right
   * corner. The list pages (`/hub`, `/campaigns`) filter rows by the viewer's
   * userId, so it's safe to always pass `true` from there — but we keep the
   * flag explicit so a future reuse against a shared (party-member) list
   * doesn't accidentally hand a guest a delete button they can't act on.
   */
  showDelete?: boolean;
};

export function CampaignCard({
  campaign,
  characterName,
  characterRace,
  characterClass,
  characterLevel,
  showDelete = false,
}: CampaignCardData) {
  return (
    <Link href={`/campaigns/${campaign.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <Card accent={campaign.status === 'active'} style={{ position: 'relative' }}>
        {showDelete && (
          <DeleteCardButton
            endpoint={`/api/campaigns/${campaign.id}`}
            confirmText={`Delete ${campaign.name}? This cannot be undone.`}
          />
        )}
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
