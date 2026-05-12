import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { checkPartyAccess } from '@/multiplayer/access';
import { buildClientSnapshot } from '@/sessions/client-snapshot';

/**
 * Returns the client-shape session snapshot used by `useSessionStream`'s
 * `refetch` path. Routed through the same `buildClientSnapshot` builder as
 * `/api/sessions/[id]/stream` so the two paths can't drift — drift here
 * historically dropped `currentPlayerCharacterId` / `viewerCharacterId` on
 * every refetch, letting players keep typing after their turn ended.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;

  const hasAccess = await checkPartyAccess(userId, id);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const snapshot = await buildClientSnapshot(id, userId);
    return NextResponse.json(snapshot);
  } catch (e) {
    if (e instanceof Error && /not found/.test(e.message)) {
      return NextResponse.json({ error: 'not-found' }, { status: 404 });
    }
    throw e;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const result = await db
    .update(sessions)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.deletedAt)));
  if ((result.rowCount ?? 0) === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
