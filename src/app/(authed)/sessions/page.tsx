import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions as sessionsTable, characters as charactersTable } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import { DeleteCardButton } from '@/components/ui/delete-card-button';

export const dynamic = 'force-dynamic';

export default async function SessionsListPage() {
  const { userId } = await auth();
  if (!userId) return null;
  await ensureUser(userId);

  const rows = await db
    .select({ session: sessionsTable, character: charactersTable })
    .from(sessionsTable)
    .leftJoin(charactersTable, eq(charactersTable.id, sessionsTable.characterId))
    .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.deletedAt)))
    .orderBy(desc(sessionsTable.updatedAt));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Sessions</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15, fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            {rows.length === 0 ? 'No sessions yet. Open the table.' : `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}.`}
          </p>
        </div>
        <Link href="/sessions/new">
          <Button variant="primary" size="md" icon="plus">New session</Button>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {rows.map(({ session: s, character: c }) => (
          <Link key={s.id} href={`/sessions/${s.id}`} style={{ color: 'inherit' }}>
            <Card accent={s.status === 'active'} style={{ position: 'relative' }}>
              <DeleteCardButton
                endpoint={`/api/sessions/${s.id}`}
                confirmText={`Delete this session with ${c?.name ?? 'this hero'}? This cannot be undone.`}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, lineHeight: 1.15 }}>
                    {c?.name ?? 'Unknown PC'}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                    <Chip tone={s.status === 'active' ? 'accent' : 'neutral'} dot={s.status === 'active'}>
                      {s.status}
                    </Chip>
                    {s.language && <Chip tone="gold">{s.language}</Chip>}
                  </div>
                </div>
                <Icon name="more" size={16} style={{ color: 'var(--fg-subtle)' }} />
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                &ldquo;{s.premise}&rdquo;
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <span>updated {new Date(s.updatedAt).toLocaleString()}</span>
              </div>
            </Card>
          </Link>
        ))}
        <Link href="/sessions/new" style={{ textDecoration: 'none' }}>
          <button
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px dashed var(--border-strong)',
              borderRadius: 8,
              padding: 18,
              minHeight: 200,
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Icon name="plus" size={24} />
            <span style={{ fontSize: 14 }}>Open the table</span>
          </button>
        </Link>
      </div>

      <div style={{ marginTop: 32, fontSize: 12, color: 'var(--fg-subtle)' }}>
        <Eyebrow>Tip</Eyebrow>
        <p style={{ marginTop: 6 }}>Sessions are stored on the server. Refresh to resume any time.</p>
      </div>
    </div>
  );
}
