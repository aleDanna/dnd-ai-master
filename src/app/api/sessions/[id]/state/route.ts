import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, combatActors } from '@/db/schema';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthenticated', { status: 401 });
  const { id: sessionId } = await params;

  let closed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      // Keepalive: forces a write every 15s so dead connections throw on next enqueue.
      keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(': keepalive\n\n'));
        } catch {
          closed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
        }
      }, 15000);

      let last = '';
      const tick = async () => {
        if (closed) return;
        const [session] = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
          .limit(1);
        if (!session) {
          try {
            send('error', { reason: 'not-found' });
          } catch {
            // controller already closed; ignore
          }
          try { controller.close(); } catch { /* already closed */ }
          closed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          return;
        }
        const [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
        const actors = await db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId));
        const payload = JSON.stringify({ session, state, actors });
        if (payload !== last) {
          try {
            send('snapshot', { session, state, actors });
          } catch {
            // client disconnected; stop polling
            closed = true;
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
            return;
          }
          last = payload;
        }
        setTimeout(tick, 1500);
      };
      tick();
    },
    cancel() {
      closed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
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
