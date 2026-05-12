import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, campaigns, characters } from '@/db/schema';
import { checkPartyAccess } from '@/multiplayer/access';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const [row] = await db
    .select({
      session: sessions,
      campaign: campaigns,
      character: characters,
    })
    .from(sessions)
    .leftJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .leftJoin(characters, eq(characters.id, sessions.characterId))
    .where(and(eq(sessions.id, id), isNull(sessions.deletedAt)))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const hasAccess = await checkPartyAccess(userId, id);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, id)).limit(1);
  const party = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.campaignId, row.session.campaignId!),
      isNull(characters.deletedAt),
      isNotNull(characters.templateId),
    ))
    .orderBy(characters.createdAt);
  return NextResponse.json({ session: row.session, campaign: row.campaign, character: row.character, state, party });
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
