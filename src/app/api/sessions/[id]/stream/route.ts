import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import {
  sessions,
  sessionState,
  combatActors,
  characters,
  campaigns,
} from '@/db/schema';
import { checkPartyAccess } from '@/multiplayer/access';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Build the client-shaped snapshot used by `useSessionStream` and the right
 * pane / character pane.
 *
 * NOTE — this is intentionally separate from `buildSnapshot()` in
 * `src/sessions/snapshot.ts`, which builds the *master-facing* SnapshotForModel
 * (an `EngineState` view with `characters[]`, `runtime{}`, etc.). The client
 * pane reads SessionStateRow-shaped state (`conditions`, `spellSlotsUsed`,
 * `inCombat`, `hpCurrent`, …) and expects `character`/`session`/`campaign` at
 * the top level — so we hand-build that shape here. Multiplayer requirement:
 * `character` MUST be the VIEWER's instance, not the host's
 * (`session.characterId` points at the host).
 */
async function buildClientSnapshot(sessionId: string, userId: string) {
  const [row] = await db
    .select({ session: sessions, campaign: campaigns })
    .from(sessions)
    .leftJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`buildClientSnapshot: session ${sessionId} not found`);
  const { session, campaign } = row;

  // The viewer's own instance character in this campaign — falls back to
  // session.characterId (host's instance) for spectators or legacy sessions.
  const [viewerChar] = session.campaignId
    ? await db
        .select()
        .from(characters)
        .where(and(
          eq(characters.campaignId, session.campaignId),
          eq(characters.userId, userId),
          isNotNull(characters.templateId),
          isNull(characters.deletedAt),
        ))
        .limit(1)
    : [];
  const character = viewerChar ?? (
    await db.select().from(characters).where(eq(characters.id, session.characterId)).limit(1)
  )[0] ?? null;

  const [state] = await db
    .select()
    .from(sessionState)
    .where(eq(sessionState.sessionId, sessionId))
    .limit(1);

  const actors = await db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId));

  const party = session.campaignId
    ? await db
        .select()
        .from(characters)
        .where(and(
          eq(characters.campaignId, session.campaignId),
          isNull(characters.deletedAt),
          isNotNull(characters.templateId),
        ))
        .orderBy(characters.createdAt)
    : [];

  return {
    session,
    campaign,
    state: state ?? null,
    character,
    actors,
    party,
    currentPlayerCharacterId: session.currentPlayerCharacterId,
    viewerCharacterId: viewerChar?.id ?? null,
  };
}

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
