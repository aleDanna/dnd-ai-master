import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, sessionState } from '@/db/schema';
import { getUserPreferences } from '@/lib/preferences';
import { resolveStyleText } from '@/ai/master/image-style';
import { generateAndPersist } from '@/sessions/scene-image-job';

/**
 * Manual scene-image trigger: the player clicked the "Generate image" button
 * next to a master message. The endpoint blocks until the image is generated
 * and persisted (~10-30s) so the client can show a loading state and surface
 * errors. The Scene panel on the right updates separately via the existing
 * /state SSE — this endpoint just bumps the version on success.
 *
 * URL: POST /api/sessions/[id]/messages/[messageId]/scene-image
 *  - id        — session UUID (must belong to the caller)
 *  - messageId — master message UUID inside that session whose narration
 *                is used as the visual prompt
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId, messageId } = await params;

  // Ownership + role check in a single round-trip.
  const [row] = await db
    .select({
      messageRole: sessionMessages.role,
      messageContent: sessionMessages.content,
      currentVersion: sessionState.sceneImageVersion,
    })
    .from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .innerJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .where(and(
      eq(sessions.id, sessionId),
      eq(sessions.userId, userId),
      isNull(sessions.deletedAt),
      eq(sessionMessages.id, messageId),
    ))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  if (row.messageRole !== 'master') {
    return NextResponse.json({ error: 'not-a-master-message' }, { status: 400 });
  }
  if (!row.messageContent.trim()) {
    return NextResponse.json({ error: 'empty-message' }, { status: 400 });
  }

  const prefs = await getUserPreferences(userId);
  if (!prefs.imageGenerationEnabled) {
    return NextResponse.json({ error: 'image-generation-disabled' }, { status: 403 });
  }
  const styleText = resolveStyleText(prefs);
  const nextVersion = row.currentVersion + 1;

  const result = await generateAndPersist(sessionId, row.messageContent, styleText, nextVersion);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason, detail: 'detail' in result ? result.detail : undefined },
      { status: result.reason === 'race_lost' ? 409 : 502 },
    );
  }
  return NextResponse.json({ version: result.version });
}
