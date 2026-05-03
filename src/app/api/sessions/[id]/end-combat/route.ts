import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState } from '@/db/schema';

/**
 * Manual escape hatch for sessions that ended up with a stuck combat state
 * (e.g. inCombat=true, combat={round:1,...} with the fight long over). The
 * master normally clears this via the end_combat tool, but for sessions that
 * predate that tool — or where the master just forgot — this lets the
 * player force the tracker back to "Exploration" mode.
 *
 * Scoped by user, like every other session endpoint.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId } = await params;

  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  await db
    .update(sessionState)
    .set({ inCombat: false, combat: null })
    .where(eq(sessionState.sessionId, sessionId));

  return NextResponse.json({ ok: true });
}
