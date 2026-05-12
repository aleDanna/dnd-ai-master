import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createListenClient } from '@/db/client';
import { checkPartyAccess } from '@/multiplayer/access';
import { buildClientSnapshot } from '@/sessions/client-snapshot';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthorized', { status: 401 });
  const { id: sessionId } = await ctx.params;

  const access = await checkPartyAccess(userId, sessionId);
  if (!access) return new Response('forbidden', { status: 403 });

  // Dedicated direct (un-pooled) connection — Neon's main DATABASE_URL is the
  // pgbouncer pooler in transaction mode, which does NOT support LISTEN.
  // `createListenClient` reads `DATABASE_URL_UNPOOLED` when present and falls
  // back to the regular URL locally.
  const client = createListenClient();
  await client.connect();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const snapshot = await buildClientSnapshot(sessionId, userId);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', snapshot })}\n\n`));
      } catch (e) {
        console.error('snapshot failed:', e);
      }

      await client.query(`LISTEN "session_${sessionId}"`);
      client.on('notification', (msg) => {
        if (msg.payload) {
          controller.enqueue(encoder.encode(`data: ${msg.payload}\n\n`));
        }
      });
      // Surface connection errors instead of swallowing them — a dropped
      // unpooled connection (Neon idle disconnect, network blip) used to
      // leave the SSE stream open but mute, with no NOTIFY ever flowing.
      client.on('error', (err) => {
        console.error('LISTEN client error:', err instanceof Error ? err.message : err);
      });

      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keep-alive\n\n`)); } catch {}
      }, 25_000);

      req.signal.addEventListener('abort', async () => {
        clearInterval(ka);
        try { await client.query(`UNLISTEN "session_${sessionId}"`); } catch {}
        try { await client.end(); } catch {}
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}
