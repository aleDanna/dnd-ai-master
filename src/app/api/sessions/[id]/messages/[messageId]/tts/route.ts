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

  // Resolve user-preferred voice
  const prefs = await getResolvedPreferences(userId);
  const voice = prefs.ttsVoice;

  // Cache hit?
  const [cached] = await db
    .select({ audioMp3: ttsCache.audioMp3 })
    .from(ttsCache)
    .where(and(eq(ttsCache.messageId, messageId), eq(ttsCache.voice, voice)))
    .limit(1);

  if (cached) {
    return new Response(new Uint8Array(cached.audioMp3), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600',
        'Content-Length': String(cached.audioMp3.byteLength),
        'X-Tts-Cache': 'HIT',
      },
    });
  }

  // Cache miss — synthesize, store, return
  let audioBytes: ArrayBuffer;
  try {
    audioBytes = await synthesizeSpeech({ text: message.content, voice });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    return NextResponse.json(
      { error: err.message ?? 'tts-failed', upstreamStatus: status },
      { status: status === 429 ? 429 : 500 },
    );
  }

  // Persist for future replays. ON CONFLICT DO NOTHING handles concurrent inserts.
  try {
    await db
      .insert(ttsCache)
      .values({ messageId, voice, audioMp3: Buffer.from(audioBytes) })
      .onConflictDoNothing();
  } catch {
    // Cache write failures should never break playback.
  }

  return new Response(audioBytes, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': String(audioBytes.byteLength),
      'X-Tts-Cache': 'MISS',
    },
  });
}
