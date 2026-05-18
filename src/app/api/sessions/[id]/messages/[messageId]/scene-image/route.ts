import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, sessionState, characters } from '@/db/schema';
import { getSessionMasterPreferences } from '@/lib/preferences';
import { resolveStyleText, buildCharacterAppearance } from '@/ai/master/image-style';
import { generateAndPersist } from '@/sessions/scene-image-job';
import { checkPartyAccess } from '@/multiplayer/access';
import { tryClaimImageJob } from '@/sessions/job-claims';
import { waitForImageReady } from '@/sessions/wait-for-job';
import { notifySession } from '@/sessions/notify';

/**
 * Manual scene-image trigger: the player clicked the "Generate image" button
 * next to a master message. Uses a leader/follower coalesce pattern so
 * concurrent requests for the same session only call the image provider once.
 *
 * The leader claims the lock (flips scene_image_pending), generates, persists,
 * then notifies. Followers wait on the `image-ready`/`image-failed` NOTIFY
 * via `waitForImageReady`, then read the persisted version.
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

  const [row] = await db
    .select({
      messageRole: sessionMessages.role,
      messageContent: sessionMessages.content,
      currentVersion: sessionState.sceneImageVersion,
      charName: characters.name,
      charRaceSlug: characters.raceSlug,
      charClassSlug: characters.classSlug,
      charIdentity: characters.identity,
    })
    .from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .innerJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .innerJoin(characters, eq(characters.id, sessions.characterId))
    .where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.deletedAt),
      eq(sessionMessages.id, messageId),
    ))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (row.messageRole !== 'master') {
    return NextResponse.json({ error: 'not-a-master-message' }, { status: 400 });
  }
  if (!row.messageContent.trim()) {
    return NextResponse.json({ error: 'empty-message' }, { status: 400 });
  }

  const prefs = await getSessionMasterPreferences(sessionId);
  if (!prefs.imageGenerationEnabled) {
    return NextResponse.json({ error: 'image-generation-disabled' }, { status: 403 });
  }

  const claim = await tryClaimImageJob(sessionId);
  if (!claim.isLeader) {
    // Follower path: leader already emitted image-pending; just wait.
    const waited = await waitForImageReady(sessionId);
    if (!waited.ok) {
      if (waited.reason === 'failed') {
        return NextResponse.json({ error: waited.detail ?? 'image-failed' }, { status: 502 });
      }
      return NextResponse.json({ error: 'image-follower-timeout' }, { status: 504 });
    }
    return NextResponse.json({ version: waited.value.sceneImageVersion });
  }

  // Leader path
  await notifySession(sessionId, { type: 'image-pending', messageId });

  const styleText = resolveStyleText(prefs);
  const characterAppearance = buildCharacterAppearance({
    name: row.charName,
    raceSlug: row.charRaceSlug,
    classSlug: row.charClassSlug,
    identity: row.charIdentity,
  });
  const nextVersion = row.currentVersion + 1;

  try {
    const result = await generateAndPersist(
      sessionId,
      row.messageContent,
      styleText,
      nextVersion,
      prefs.imageProvider,
      prefs.imageModel,
      characterAppearance,
    );

    if (!result.ok) {
      await db.update(sessionState)
        .set({ sceneImagePending: false, sceneImageFailedReason: result.reason })
        .where(eq(sessionState.sessionId, sessionId));
      await notifySession(sessionId, { type: 'image-failed', reason: result.reason });
      return NextResponse.json(
        { error: result.reason, detail: 'detail' in result ? result.detail : undefined },
        { status: result.reason === 'race_lost' ? 409 : 502 },
      );
    }

    await db.update(sessionState)
      .set({ sceneImagePending: false, sceneImageFailedReason: null })
      .where(eq(sessionState.sessionId, sessionId));
    await notifySession(sessionId, { type: 'image-ready' });
    return NextResponse.json({ version: result.version });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'image-failed';
    await db.update(sessionState)
      .set({ sceneImagePending: false, sceneImageFailedReason: reason })
      .where(eq(sessionState.sessionId, sessionId));
    await notifySession(sessionId, { type: 'image-failed', reason });
    throw e;
  }
}
