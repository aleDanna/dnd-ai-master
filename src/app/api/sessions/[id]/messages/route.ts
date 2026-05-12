import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages } from '@/db/schema';
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

  // Return the LATEST 200 messages (then reverse to ascending for the client).
  // The previous version used asc + limit 200, which silently truncated the
  // newest messages once a session crossed 200 turns — players reported the
  // chat "always reopening at message #200" and never seeing recent activity.
  const recent = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(200);
  const messages = recent.reverse();

  return NextResponse.json({ messages });
}
