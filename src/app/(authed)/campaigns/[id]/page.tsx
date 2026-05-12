import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { getCampaign } from '@/campaigns/persist';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Icon } from '@/components/ui/icon';
import { DeleteCardButton } from '@/components/ui/delete-card-button';
import { RenameHeading } from './rename-heading';

export const dynamic = 'force-dynamic';

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const { id } = await params;
  const data = await getCampaign(userId, id);
  if (!data) notFound();
  const { campaign, character, activeSession } = data;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <RenameHeading campaignId={campaign.id} initialName={campaign.name} />
          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <Chip tone={campaign.status === 'active' ? 'accent' : 'neutral'} dot={campaign.status === 'active'}>{campaign.status}</Chip>
            <Chip tone="neutral">{campaign.style}</Chip>
            {campaign.language && <Chip tone="gold">{campaign.language}</Chip>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {activeSession ? (
            <Link href={`/sessions/${activeSession.id}`}>
              <Button variant="primary" size="md" iconRight="arrow-right">Continue</Button>
            </Link>
          ) : (
            <Button variant="primary" size="md" disabled>Resume not available</Button>
          )}
          <DeleteCardButton endpoint={`/api/campaigns/${campaign.id}`} confirmText={`Delete ${campaign.name}? This cannot be undone.`} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 18 }}>
        <Card>
          {character ? (
            <Link href={`/characters/${character.templateId ?? character.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{character.name}</div>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{character.raceSlug} · {character.classSlug} · L{character.level}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>HP {character.hpMax} · AC {character.ac}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 8 }}><Icon name="arrow-right" size={12}/> view sheet</div>
            </Link>
          ) : (
            <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>No character bound to this campaign.</div>
          )}
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Premise</div>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, lineHeight: 1.55 }}>
            &ldquo;{campaign.premise}&rdquo;
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: 'var(--fg-muted)' }}>
        {campaign.lastPlayedAt && <>Last played: {new Date(campaign.lastPlayedAt).toLocaleString()} · </>}
        Created: {new Date(campaign.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}
