import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getMyCharacter } from '@/characters/persist';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import { Button } from '@/components/ui/button';
import { DeleteResourceButton } from '@/components/ui/delete-resource-button';
import { MiniStat } from '@/components/layout/mini-stat';
import { HpBar } from '@/components/layout/hp-bar';
import { abilityModifier } from '@/engine/modifiers';

export const dynamic = 'force-dynamic';

export default async function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;
  const { id } = await params;
  const ch = await getMyCharacter(userId, id);
  if (!ch) notFound();

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 8,
            background: ch.identity?.portraitColor ?? 'var(--bone)',
            color: 'var(--ink)',
            fontFamily: 'var(--font-display)',
            fontSize: 36,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {ch.name[0]}
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 36, fontWeight: 600 }}>{ch.name}</h1>
          <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
            <Chip tone="accent">{ch.raceSlug}</Chip>
            <Chip tone="warn">{ch.classSlug} {ch.level}</Chip>
            <Chip tone="gold">{ch.backgroundSlug}</Chip>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/hub"><Button variant="ghost" size="md">Back to hub</Button></Link>
          <DeleteResourceButton
            endpoint={`/api/characters/${ch.id}`}
            confirmText={`Delete ${ch.name}? This cannot be undone.`}
            redirectTo="/hub"
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <Eyebrow>Vitals</Eyebrow>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>HP</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>{ch.hpMax}/{ch.hpMax}</span>
            </div>
            <div style={{ marginTop: 8 }}>
              <HpBar current={ch.hpMax} max={ch.hpMax} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <MiniStat label="AC" value={ch.ac} />
            <MiniStat label="Speed" value={ch.speed} />
            <MiniStat label="Prof" value={`+${ch.proficiencyBonus}`} />
          </div>
        </Card>

        <Card>
          <Eyebrow>Abilities</Eyebrow>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const).map((k) => {
              const v = ch.abilities[k];
              const mod = abilityModifier(v);
              return (
                <div
                  key={k}
                  style={{
                    background: 'var(--bg-sunken)',
                    borderRadius: 6,
                    padding: 8,
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>{k}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600 }}>{v}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>
                    {mod >= 0 ? '+' : ''}
                    {mod}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card style={{ gridColumn: '1 / -1' }}>
          <Eyebrow>Identity</Eyebrow>
          <div style={{ fontSize: 14, color: 'var(--fg-muted)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><strong>Alignment:</strong> {ch.identity?.alignment}</div>
            {ch.identity?.trait && <div><strong>Trait:</strong> {ch.identity.trait}</div>}
            {ch.identity?.bond && <div><strong>Bond:</strong> {ch.identity.bond}</div>}
            {ch.identity?.flaw && <div><strong>Flaw:</strong> {ch.identity.flaw}</div>}
            {ch.identity?.backstory && <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', marginTop: 8 }}>{ch.identity.backstory}</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}
