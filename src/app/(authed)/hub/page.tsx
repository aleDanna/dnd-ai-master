import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { eq, isNull, isNotNull, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters as charactersTable } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { listCampaigns } from '@/campaigns/persist';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { DeleteCardButton } from '@/components/ui/delete-card-button';
import { MiniStat } from '@/components/layout/mini-stat';
import { CampaignCard } from '@/components/campaigns/campaign-card';

export const dynamic = 'force-dynamic';

export default async function HubPage() {
  const { userId, sessionClaims } = await auth();
  if (!userId) return null;
  await ensureUser(userId, (sessionClaims?.name as string | undefined) ?? null);

  const myChars = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.userId, userId),
      isNull(charactersTable.deletedAt),
      isNull(charactersTable.templateId),  // hide per-session instance forks
    ));

  // listCampaigns is multiplayer-aware — it returns both host campaigns and
  // campaigns the viewer joined via invite. We then join the viewer's own
  // instance character per campaign so the card hint says "you play X"
  // rather than the host's character.
  const allCampaigns = await listCampaigns(userId);
  const top3 = allCampaigns.slice(0, 3);
  const myInstances = top3.length > 0
    ? await db
        .select()
        .from(charactersTable)
        .where(and(
          eq(charactersTable.userId, userId),
          isNotNull(charactersTable.templateId),
          isNull(charactersTable.deletedAt),
          inArray(
            charactersTable.campaignId,
            top3.map((c) => c.id),
          ),
        ))
    : [];
  const instanceByCampaign = new Map(myInstances.map((c) => [c.campaignId, c]));
  const recentCampaigns = top3.map((campaign) => ({
    campaign,
    character: instanceByCampaign.get(campaign.id) ?? null,
  }));

  const hasCharacters = myChars.length > 0;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Your table</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15, fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            {myChars.length === 0 ? 'No heroes yet. Roll your first.' : `${myChars.length} ${myChars.length === 1 ? 'hero' : 'heroes'} between rests.`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/characters/new"><Button variant="secondary" size="md" icon="plus">New character</Button></Link>
          {hasCharacters && (
            <Link href="/campaigns/new"><Button variant="primary" size="md" iconRight="arrow-right">New campaign</Button></Link>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <Eyebrow>Heroes</Eyebrow>
        <h2 style={{ fontSize: 24, fontWeight: 600 }}>Your characters</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)' }}>{myChars.length}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {myChars.map((ch) => (
          <Link key={ch.id} href={`/characters/${ch.id}`} style={{ color: 'inherit' }}>
            <Card style={{ position: 'relative' }}>
              <DeleteCardButton
                endpoint={`/api/characters/${ch.id}`}
                confirmText={`Delete ${ch.name}? This cannot be undone.`}
              />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 8,
                    background: ch.identity?.portraitColor ?? 'var(--bone)',
                    color: 'var(--ink)',
                    fontFamily: 'var(--font-display)',
                    fontSize: 22,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {ch.name[0]}
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, lineHeight: 1.1 }}>{ch.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                    {ch.raceSlug} · {ch.classSlug} {ch.level}
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                <MiniStat label="HP" value={ch.hpMax} />
                <MiniStat label="AC" value={ch.ac} />
                <MiniStat label="LVL" value={ch.level} />
              </div>
            </Card>
          </Link>
        ))}
        <Link href="/characters/new" style={{ textDecoration: 'none' }}>
          <button
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px dashed var(--border-strong)',
              borderRadius: 8,
              padding: 18,
              minHeight: 140,
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Icon name="plus" size={20} />
            <span style={{ fontSize: 13 }}>Roll a new character</span>
          </button>
        </Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 40, marginBottom: 16 }}>
        <Eyebrow>Campaigns</Eyebrow>
        <h2 style={{ fontSize: 24, fontWeight: 600 }}>Active and recent</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)' }}>{recentCampaigns.length}</span>
        {recentCampaigns.length > 0 && (
          <Link href="/campaigns" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
            View all →
          </Link>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {recentCampaigns.map(({ campaign, character }) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            characterName={character?.name}
            characterRace={character?.raceSlug}
            characterClass={character?.classSlug}
            characterLevel={character?.level}
            // Only the host can delete a campaign — for joined-via-invite
            // entries we still show the card (so the viewer can resume) but
            // hide the destructive affordance they can't act on anyway.
            showDelete={campaign.userId === userId}
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
            <Icon name="plus" size={24}/>
            <span style={{ fontSize: 14 }}>Start a new campaign</span>
          </button>
        </Link>
      </div>
    </div>
  );
}
