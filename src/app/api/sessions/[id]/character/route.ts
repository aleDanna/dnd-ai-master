import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, characters } from '@/db/schema';
import { checkPartyAccess } from '@/multiplayer/access';

/**
 * Returns the VIEWER's character within this session's campaign. Used by the
 * client to refresh mutable character fields (level, xp, hpMax, etc.) without
 * round-tripping through the full server-rendered page.
 *
 * Multiplayer: each party member sees THEIR OWN character, not the host's
 * (session.characterId always points at the host's instance). Falls back to
 * session.characterId if the viewer has no instance in the party (e.g. host
 * acting as spectator — edge case).
 */
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

  const access = await checkPartyAccess(userId, sessionId);
  if (!access) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Find the viewer's own instance in this campaign first.
  const [viewerChar] = session.campaignId
    ? await db
        .select()
        .from(characters)
        .where(and(
          eq(characters.campaignId, session.campaignId),
          eq(characters.userId, userId),
          isNotNull(characters.templateId),
          isNull(characters.deletedAt),
        ))
        .limit(1)
    : [];
  if (viewerChar) return NextResponse.json({ character: viewerChar });

  // Fallback to the session's character (host's instance) for spectators or
  // legacy single-character sessions.
  const [fallback] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, session.characterId), isNull(characters.deletedAt)))
    .limit(1);
  if (!fallback) return NextResponse.json({ error: 'character-not-found' }, { status: 404 });
  return NextResponse.json({ character: fallback });
}
