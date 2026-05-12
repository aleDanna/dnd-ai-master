import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { getCampaign } from '@/campaigns/persist';
import { db } from '@/db/client';
import { characters } from '@/db/schema';
import { listActiveInvites } from '@/multiplayer/invites';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Icon } from '@/components/ui/icon';
import { DeleteResourceButton } from '@/components/ui/delete-resource-button';
import { InviteSection } from '@/components/campaigns/invite-section';
import { RenameHeading } from './rename-heading';

export const dynamic = 'force-dynamic';

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const { id } = await params;
  const data = await getCampaign(userId, id);
  if (!data) notFound();
  const { campaign, activeSession } = data;

  const isHost = userId === campaign.userId;

  const rawInvites = isHost ? await listActiveInvites(id) : [];
  const invites = rawInvites.map((inv) => ({
    id: inv.id,
    token: inv.token,
    expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    maxUses: inv.maxUses ?? null,
    usesCount: inv.usesCount,
  }));

  const party = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.campaignId, id),
      isNotNull(characters.templateId),
      isNull(characters.deletedAt),
    ))
    .orderBy(characters.createdAt);

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
          {isHost && (
            <DeleteResourceButton
              endpoint={`/api/campaigns/${campaign.id}`}
              confirmText={`Delete ${campaign.name}? This cannot be undone.`}
              redirectTo="/campaigns"
            />
          )}
        </div>
      </div>

      {isHost && (
        <div style={{ marginTop: 18, marginBottom: 18 }}>
          <InviteSection campaignId={id} initial={{ invites }} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 18, marginTop: 18 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
            Party ({party.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {party.length === 0 && (
              <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>No characters in this campaign yet.</div>
            )}
            {party.map((p) => (
              <Card key={p.id} style={{ padding: 12 }}>
                {p.userId === userId && p.templateId ? (
                  <Link href={`/characters/${p.templateId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {p.name}<span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}> (you)</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.raceSlug} · {p.classSlug} · L{p.level}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>HP {p.hpMax} · AC {p.ac}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}><Icon name="arrow-right" size={12} /> view sheet</div>
                  </Link>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {p.name}{p.userId === userId && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}> (you)</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.raceSlug} · {p.classSlug} · L{p.level}</div>
                  </>
                )}
              </Card>
            ))}
          </div>
        </div>
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
