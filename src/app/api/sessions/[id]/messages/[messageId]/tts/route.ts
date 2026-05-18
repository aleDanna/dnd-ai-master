import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, ttsCache } from '@/db/schema';
import { synthesizeSpeech } from '@/ai/tts';
import { getSessionMasterPreferences } from '@/lib/preferences';
import { checkPartyAccess } from '@/multiplayer/access';
import { tryClaimTtsJob } from '@/sessions/job-claims';
import { waitForTtsReady } from '@/sessions/wait-for-job';
import { notifySession } from '@/sessions/notify';

function audioResponse(body: Buffer, mimeType: string, cacheHeader: string): Response {
  // Next 16 App Router runs on Web-Fetch primitives; Response accepts
  // Uint8Array but not Node Buffer directly. Wrapping in `new Uint8Array(buf)`
  // is zero-copy (shares the buffer) and narrows the type to
  // Uint8Array<ArrayBuffer>, which satisfies BodyInit under strict TS lib.
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': String(body.byteLength),
      'X-Tts-Cache': cacheHeader,
    },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId, messageId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const [message] = await db
    .select()
    .from(sessionMessages)
    .where(and(eq(sessionMessages.id, messageId), eq(sessionMessages.sessionId, sessionId)))
    .limit(1);
  if (!message) return NextResponse.json({ error: 'message-not-found' }, { status: 404 });
  if (message.role !== 'master') {
    return NextResponse.json({ error: 'tts-master-only' }, { status: 400 });
  }

  const prefs = await getSessionMasterPreferences(sessionId);
  const provider = prefs.ttsProvider;
  const voice = prefs.ttsVoice;
  const model = prefs.ttsModel;

  const claim = await tryClaimTtsJob(messageId, voice, model, provider);

  if (claim.result === 'ready') {
    const row = claim.existing;
    return audioResponse(row.audioMp3!, row.mimeType ?? 'audio/mpeg', 'HIT');
  }

  if (claim.result === 'leader') {
    await notifySession(sessionId, { type: 'tts-pending', messageId });
    try {
      const out = await synthesizeSpeech({ text: message.content, provider, voice, model });
      const buf = Buffer.from(out.bytes);
      await db.update(ttsCache)
        .set({ status: 'ready', audioMp3: buf, mimeType: out.mimeType })
        .where(and(
          eq(ttsCache.messageId, messageId),
          eq(ttsCache.voice, voice),
          eq(ttsCache.model, model),
        ));
      await notifySession(sessionId, { type: 'tts-ready', messageId });
      return audioResponse(buf, out.mimeType, 'MISS');
    } catch (e) {
      const err = e as { status?: number; message?: string };
      const reason = err.message ?? 'tts-failed';
      console.error('tts.synth_failed', { provider, voice, model, messageId, status: err.status, message: reason });
      await db.update(ttsCache)
        .set({ status: 'failed', failedReason: reason })
        .where(and(
          eq(ttsCache.messageId, messageId),
          eq(ttsCache.voice, voice),
          eq(ttsCache.model, model),
        ));
      await notifySession(sessionId, { type: 'tts-failed', messageId, reason });
      const status = typeof err.status === 'number' && err.status === 429 ? 429 : 500;
      return NextResponse.json({ error: reason, upstreamStatus: err.status }, { status });
    }
  }

  // follower path: wait for the leader to complete
  const waited = await waitForTtsReady(sessionId, messageId, voice, model);
  if (!waited.ok) {
    if (waited.reason === 'failed') {
      return NextResponse.json({ error: waited.detail ?? 'tts-failed' }, { status: 500 });
    }
    return NextResponse.json({ error: 'tts-follower-timeout' }, { status: 504 });
  }
  const row = waited.value;
  return audioResponse(row.audioMp3!, row.mimeType ?? 'audio/mpeg', 'FOLLOWER');
}
