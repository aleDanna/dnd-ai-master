import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState } from '@/db/schema';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, id)).limit(1);
  return NextResponse.json({ session, state });
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
