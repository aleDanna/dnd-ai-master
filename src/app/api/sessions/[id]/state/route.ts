import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, combatActors, characters } from '@/db/schema';

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
        const [state] = await db
          .select({
            sessionId: sessionState.sessionId,
            hpCurrent: sessionState.hpCurrent,
            tempHp: sessionState.tempHp,
            hitDiceRemaining: sessionState.hitDiceRemaining,
            spellSlotsUsed: sessionState.spellSlotsUsed,
            conditions: sessionState.conditions,
            resourcesUsed: sessionState.resourcesUsed,
            inCombat: sessionState.inCombat,
            combat: sessionState.combat,
            scene: sessionState.scene,
            inventoryDelta: sessionState.inventoryDelta,
            statusFlag: sessionState.statusFlag,
            sceneImageVersion: sessionState.sceneImageVersion,
            sceneImagePrompt: sessionState.sceneImagePrompt,
          })
          .from(sessionState)
          .where(eq(sessionState.sessionId, sessionId))
          .limit(1);
        const actors = await db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId));
        // Mutable character fields — XP, level, hpMax, AC, inventory,
        // spellcasting — all of which the master can change mid-turn.
        // Including them in the snapshot guarantees the right-pane UI
        // (XP bar, character pane, spell slots) stays fresh without
        // depending on the turn_complete refetch path, which has a
        // history of racing with effect re-renders and silently
        // dropping updates.
        const [character] = await db
          .select({
            id: characters.id,
            name: characters.name,
            level: characters.level,
            xp: characters.xp,
            hpMax: characters.hpMax,
            ac: characters.ac,
            proficiencyBonus: characters.proficiencyBonus,
            inventory: characters.inventory,
            spellcasting: characters.spellcasting,
            features: characters.features,
          })
          .from(characters)
          .where(eq(characters.id, session.characterId))
          .limit(1);
        const payload = JSON.stringify({ session, state, actors, character });
        if (payload !== last) {
          try {
            send('snapshot', { session, state, actors, character });
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
