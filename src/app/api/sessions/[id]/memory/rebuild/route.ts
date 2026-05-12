import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { rebuildMemoryStream } from '@/sessions/memory/extractor';
import { getSessionMasterPreferences } from '@/lib/preferences';
import { checkPartyAccess } from '@/multiplayer/access';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return json({ error: 'unauthenticated' }, 401);
  const { id: sessionId } = await params;

  // NB: any party member may trigger the rebuild — the client-side
  // MemoryStatusBanner fires this on mount for everyone in the session, so
  // the previous host-only `eq(sessions.userId, userId)` filter left guests
  // stuck on "Preparazione memoria in corso…" forever (the 404 response is
  // not event-stream-shaped, so the reader loop exited without ever calling
  // `onReady`). Concurrent triggers are safe — the extractor checkpoints
  // chapters into `session_chapters` and is idempotent on re-entry.
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return json({ error: 'not-found' }, 404);
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return json({ error: 'forbidden' }, 403);

  // Memory belongs to the session, not the challer — use the host's AI prefs
  // so the rebuilt chapters speak the same Master "voice" as the live turns.
  const prefs = await getSessionMasterPreferences(sessionId);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const evt of rebuildMemoryStream(sessionId, prefs.aiProvider)) {
          if (evt.event === 'error') {
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify(evt.data)}\n\n`),
            );
            break;
          }
          controller.enqueue(
            encoder.encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`),
          );
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: e instanceof Error ? e.message : String(e) })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
