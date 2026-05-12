import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, diceLog } from '@/db/schema';
import { checkPartyAccess } from '@/multiplayer/access';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const rolls = await db
    .select()
    .from(diceLog)
    .where(eq(diceLog.sessionId, sessionId))
    .orderBy(desc(diceLog.createdAt))
    .limit(50);

  return NextResponse.json({ rolls });
}
