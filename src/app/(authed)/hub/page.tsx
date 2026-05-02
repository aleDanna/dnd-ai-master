import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters as charactersTable } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { MiniStat } from '@/components/layout/mini-stat';

export const dynamic = 'force-dynamic';

export default async function HubPage() {
  const { userId, sessionClaims } = await auth();
  if (!userId) return null;
  await ensureUser(userId, (sessionClaims?.name as string | undefined) ?? null);

  const myChars = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.userId, userId), isNull(charactersTable.deletedAt)));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Your table</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15, fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            {myChars.length === 0 ? 'No heroes yet. Roll your first.' : `${myChars.length} ${myChars.length === 1 ? 'hero' : 'heroes'} between rests.`}
          </p>
        </div>
        <Link href="/characters/new"><Button variant="primary" size="md" icon="plus">New character</Button></Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <Eyebrow>Heroes</Eyebrow>
        <h2 style={{ fontSize: 24, fontWeight: 600 }}>Your characters</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)' }}>{myChars.length}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {myChars.map((ch) => (
          <Link key={ch.id} href={`/characters/${ch.id}`} style={{ color: 'inherit' }}>
            <Card>
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
    </div>
  );
}
