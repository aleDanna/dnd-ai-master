import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, ttsCache } from '@/db/schema';
import { synthesizeSpeech } from '@/ai/tts';
import { getResolvedPreferences } from '@/lib/preferences';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId, messageId } = await params;

  // Verify session ownership
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  // Load the message — must belong to this session
  const [message] = await db
    .select()
    .from(sessionMessages)
    .where(and(eq(sessionMessages.id, messageId), eq(sessionMessages.sessionId, sessionId)))
    .limit(1);
  if (!message) return NextResponse.json({ error: 'message-not-found' }, { status: 404 });
  if (message.role !== 'master') {
    return NextResponse.json({ error: 'tts-master-only' }, { status: 400 });
  }

  // Resolve user-preferred provider + voice + model. Cache key is
  // (message, voice, model); voice/model namespaces are disjoint across
  // providers, so we don't need provider in the PK. We do store provider +
  // mimeType as columns so the route can return the right Content-Type.
  const prefs = await getResolvedPreferences(userId);
  const provider = prefs.ttsProvider;
  const voice = prefs.ttsVoice;
  const model = prefs.ttsModel;

  // Cache hit?
  const [cached] = await db
    .select({ audioMp3: ttsCache.audioMp3, mimeType: ttsCache.mimeType })
    .from(ttsCache)
    .where(
      and(eq(ttsCache.messageId, messageId), eq(ttsCache.voice, voice), eq(ttsCache.model, model)),
    )
    .limit(1);

  if (cached) {
    return new Response(new Uint8Array(cached.audioMp3), {
      headers: {
        'Content-Type': cached.mimeType,
        'Cache-Control': 'private, max-age=3600',
        'Content-Length': String(cached.audioMp3.byteLength),
        'X-Tts-Cache': 'HIT',
      },
    });
  }

  // Cache miss — synthesize, store, return
  let audioBytes: ArrayBuffer;
  let mimeType: string;
  try {
    const out = await synthesizeSpeech({ text: message.content, provider, voice, model });
    audioBytes = out.bytes;
    mimeType = out.mimeType;
  } catch (e) {
    const err = e as { status?: number; message?: string; stack?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    // Log the real error server-side so diagnosing failures (wrong model name,
    // missing API key, vendor-specific limits) doesn't require enabling debug
    // builds. The client only sees the message; the stack stays on the server.
    console.error('tts.synth_failed', {
      provider,
      voice,
      model,
      messageId,
      status,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
    });
    return NextResponse.json(
      { error: err.message ?? 'tts-failed', upstreamStatus: status },
      { status: status === 429 ? 429 : 500 },
    );
  }

  // Persist for future replays. ON CONFLICT DO NOTHING handles concurrent inserts.
  try {
    await db
      .insert(ttsCache)
      .values({ messageId, voice, model, provider, mimeType, audioMp3: Buffer.from(audioBytes) })
      .onConflictDoNothing();
  } catch {
    // Cache write failures should never break playback.
  }

  return new Response(audioBytes, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': String(audioBytes.byteLength),
      'X-Tts-Cache': 'MISS',
    },
  });
}
