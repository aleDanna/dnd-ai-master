import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, count, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, sessionChapters } from '@/db/schema';
import { checkPartyAccess } from '@/multiplayer/access';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return json({ error: 'unauthenticated' }, 401);
  const { id: sessionId } = await params;

  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return json({ error: 'not-found' }, 404);
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return json({ error: 'forbidden' }, 403);

  // count non-OOC messages
  const [msgRow] = await db
    .select({ c: count() })
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.sessionId, sessionId),
        sql`left(trim(${sessionMessages.content}), 1) <> '!'`,
      ),
    );
  const messageCount = Number(msgRow?.c ?? 0);

  const [chRow] = await db
    .select({ c: count() })
    .from(sessionChapters)
    .where(eq(sessionChapters.sessionId, sessionId));
  const chapterCount = Number(chRow?.c ?? 0);

  const needsBackfill = messageCount >= 40 && chapterCount === 0;

  return json({ messageCount, chapterCount, needsBackfill }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
