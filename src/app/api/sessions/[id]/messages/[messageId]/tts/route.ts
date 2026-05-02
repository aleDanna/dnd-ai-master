import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages } from '@/db/schema';
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

  // Synthesize
  let audioBytes: ArrayBuffer;
  try {
    audioBytes = await synthesizeSpeech({ text: message.content, voice: prefs.ttsVoice });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    return NextResponse.json(
      { error: err.message ?? 'tts-failed', upstreamStatus: status },
      { status: status === 429 ? 429 : 500 },
    );
  }

  return new Response(audioBytes, {
    headers: {
      'Content-Type': 'audio/mpeg',
      // Per-user caching only — same URL produces the same audio (message text is immutable).
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': String(audioBytes.byteLength),
    },
  });
}
