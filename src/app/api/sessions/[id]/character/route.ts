import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, characters } from '@/db/schema';

/**
 * Returns the character bound to the given session. Used by the client to
 * refresh mutable character fields (level, xp, hpMax, etc.) without
 * round-tripping through the full server-rendered page — so the right-pane
 * XP bar and other character-derived UI stay in sync after the master
 * awards XP, levels up the PC, or otherwise mutates the sheet.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const [character] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, session.characterId), eq(characters.userId, userId), isNull(characters.deletedAt)))
    .limit(1);
  if (!character) return NextResponse.json({ error: 'character-not-found' }, { status: 404 });

  return NextResponse.json({ character });
}
