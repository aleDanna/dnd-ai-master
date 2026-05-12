import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/db/client';
import { buildSnapshot } from '@/sessions/snapshot';
import { checkPartyAccess } from '@/multiplayer/access';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthorized', { status: 401 });
  const { id: sessionId } = await ctx.params;

  const access = await checkPartyAccess(userId, sessionId);
  if (!access) return new Response('forbidden', { status: 403 });

  const client = await pool.connect();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const snapshot = await buildSnapshot(sessionId, userId);
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

      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keep-alive\n\n`)); } catch {}
      }, 25_000);

      req.signal.addEventListener('abort', async () => {
        clearInterval(ka);
        try { await client.query(`UNLISTEN "session_${sessionId}"`); } catch {}
        client.release();
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
