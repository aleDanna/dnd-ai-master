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

  const [template] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, body.characterId), eq(characters.userId, userId), isNull(characters.deletedAt)))
    .limit(1);
  if (!template) return NextResponse.json({ error: 'character-not-found' }, { status: 404 });

  // Per-campaign isolation (PHB single-player): a template character can be
  // played in many campaigns without progression bleeding across them. We
  // deep-copy the template into a session-bound *instance* (templateId set
  // to the template's id). All in-game mutations (level-up, XP, inventory,
  // spell slots, attunement, classes, etc.) write to the instance row, so
  // the template remains pristine and reusable for future campaigns.
  //
  // Backward-compat: if the user passed an instance id (templateId NOT
  // NULL), we treat it as already-forked and reuse it. This shouldn't
  // happen under normal flow but keeps re-creation idempotent if the
  // client retries.
  let sessionCharacterId: string;
  if (template.templateId) {
    sessionCharacterId = template.id;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _ignore, createdAt: _c, updatedAt: _u, ...templateData } = template;
    const [instance] = await db
      .insert(characters)
      .values({ ...templateData, templateId: template.id })
      .returning();
    if (!instance) return NextResponse.json({ error: 'fork-failed' }, { status: 500 });
    sessionCharacterId = instance.id;
  }

  const [session] = await db.insert(sessions).values({ userId, characterId: sessionCharacterId, premise: body.premise }).returning();
  await db.insert(sessionState).values({
    sessionId: session!.id,
    hpCurrent: template.hpMax,
    hitDiceRemaining: template.hitDiceMax,
  });
  return NextResponse.json({ id: session!.id });
}
