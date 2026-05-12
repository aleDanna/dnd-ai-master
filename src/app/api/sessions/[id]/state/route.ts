import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, combatActors, characters } from '@/db/schema';
import { enrichInventoryItems, formatEnrichedForMaster } from '@/srd/enrich-inventory';
import { checkPartyAccess } from '@/multiplayer/access';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthenticated', { status: 401 });
  const { id: sessionId } = await params;

  // One-time party access check before opening the SSE stream.
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) return new Response('forbidden', { status: 403 });

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
        // Wrap the entire tick body in try/catch. A transient DB error
        // (e.g. Neon serverless disconnect) used to throw out of this
        // function and skip the setTimeout(tick, 1500) at the end —
        // silently stalling the SSE forever. The browser's EventSource
        // stayed open (keepalives kept arriving) but no new snapshots,
        // so the right-pane UI was frozen on whatever state was
        // current when the blip happened.
        try {
          const [session] = await db
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
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
              // Phase 1-10: travel, turnState (PC), position (PC) — surfaced
              // to the right-pane UI for the multiclass branch.
              travel: sessionState.travel,
              turnState: sessionState.turnState,
              position: sessionState.position,
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
              // Phase 4/5/8/9/10: surface the new PC-level fields.
              inspiration: characters.inspiration,
              attunedItems: characters.attunedItems,
              equippedFocus: characters.equippedFocus,
              classes: characters.classes,
              senses: characters.senses,
            })
            .from(characters)
            .where(eq(characters.id, session.characterId))
            .limit(1);

          // Enriched view for the left-pane UI: lets the client display narrative
          // items by name + (narrativo) suffix without a per-item codex lookup.
          // Empty inventory short-circuits to skip the round-trip.
          const enrichedInventory = character && character.inventory.length > 0
            ? formatEnrichedForMaster(await enrichInventoryItems(character.inventory, { sessionId }))
            : [];

          const characterWithEnriched = character ? { ...character, enrichedInventory } : null;
          const payload = JSON.stringify({ session, state, actors, character: characterWithEnriched });
          if (payload !== last) {
            try {
              send('snapshot', { session, state, actors, character: characterWithEnriched });
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
        } catch (e) {
          // Log but keep the polling alive. The next tick will retry the
          // queries; if the DB has recovered we resume normally.
          console.warn('[state-sse] tick failed, retrying next interval', { sessionId, error: e instanceof Error ? e.message : String(e) });
        }
        if (!closed) setTimeout(tick, 1500);
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
