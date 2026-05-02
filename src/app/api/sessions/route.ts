import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, characters } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { checkQuotas } from '@/ai/master/quotas';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .orderBy(desc(sessions.updatedAt));
  return NextResponse.json({ sessions: rows });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { characterId?: string; premise?: string } | null;
  if (!body?.characterId || !body?.premise) {
    return NextResponse.json({ error: 'missing-fields' }, { status: 400 });
  }
  await ensureUser(userId);

  const quota = await checkQuotas({ userId, kind: 'create_session' });
  if (!quota.ok) return NextResponse.json({ error: quota.reason }, { status: 429 });

  const [character] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, body.characterId), eq(characters.userId, userId), isNull(characters.deletedAt)))
    .limit(1);
  if (!character) return NextResponse.json({ error: 'character-not-found' }, { status: 404 });

  const [session] = await db.insert(sessions).values({ userId, characterId: character.id, premise: body.premise }).returning();
  await db.insert(sessionState).values({
    sessionId: session!.id,
    hpCurrent: character.hpMax,
    hitDiceRemaining: character.hitDiceMax,
  });
  return NextResponse.json({ id: session!.id });
}
