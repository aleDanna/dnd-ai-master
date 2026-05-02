import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, desc, isNull } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { db } from '@/db/client';
import { sessions, sessionMessages } from '@/db/schema';
import { buildSnapshot } from '@/sessions/snapshot';
import { applyMutations } from '@/sessions/applicator';
import { acquireTurnLock, releaseTurnLock } from '@/sessions/lock';
import { buildSrdContext } from '@/ai/master/srd-context';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';
import { detectLanguage } from '@/ai/master/language';
import { runToolLoop } from '@/ai/master/tool-loop';
import { getAnthropicClient, MASTER_MODEL } from '@/ai/master/anthropic-client';
import { recordUsage } from '@/ai/master/usage';
import { checkQuotas } from '@/ai/master/quotas';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return jsonResponse({ error: 'unauthenticated' }, 401);
  const { id: sessionId } = await params;
  const body = (await req.json().catch(() => null)) as { message?: string } | null;
  if (!body?.message?.trim()) return jsonResponse({ error: 'missing-message' }, 400);

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return jsonResponse({ error: 'not-found' }, 404);

  const quota = await checkQuotas({ userId });
  if (!quota.ok) return jsonResponse({ error: quota.reason }, 429);

  const lock = await acquireTurnLock(sessionId);
  if (!lock.acquired) return jsonResponse({ error: 'turn_in_progress' }, 409);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const t0 = Date.now();
      try {
        // 1. Persist player message
        const [pm] = await db.insert(sessionMessages).values({ sessionId, role: 'player', content: body.message! }).returning();
        send('player_message_persisted', { messageId: pm!.id });

        // 2. Language detection if not pinned (reuse session loaded for ownership check)
        if (!session.language) {
          const code = await detectLanguage({ text: body.message!, userId, sessionId });
          if (code) await db.update(sessions).set({ language: code }).where(eq(sessions.id, sessionId));
        }

        // 3. Build snapshot
        const snap = await buildSnapshot(sessionId, userId);

        // 4. Build system prompt + history
        const srd = await buildSrdContext();
        const sys = buildMasterSystemPrompt({
          srdContext: srd,
          characterMonoSpace: snap.characterMonoSpace,
          scene: snap.scene,
          language: snap.language,
        });

        const recent = await db
          .select()
          .from(sessionMessages)
          .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.cacheBreakpoint, false)))
          .orderBy(desc(sessionMessages.createdAt))
          .limit(20);
        const history: Anthropic.Messages.MessageParam[] = recent
          .reverse()
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'master' ? 'assistant' : 'user', content: m.content }));

        // 5. Run the tool loop
        const result = await runToolLoop({
          client: getAnthropicClient(),
          model: MASTER_MODEL,
          systemBlocks: sys.system,
          history,
          state: snap.state,
          applyMutations: (muts, rolls) => applyMutations(sessionId, muts, rolls),
          recordUsage: async (usage) => {
            await recordUsage({
              userId,
              sessionId,
              endpoint: 'master',
              model: MASTER_MODEL,
              usage: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadTokens: (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
                cacheCreationTokens: (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
              },
            });
          },
        });

        // 6. Stream all events to the client
        for (const ev of result.events) {
          send(ev.type, ev);
        }

        // 7. Persist master message
        const [mm] = await db.insert(sessionMessages).values({ sessionId, role: 'master', content: result.finalText }).returning();
        send('turn_complete', { messageId: mm!.id, durationMs: Date.now() - t0, toolCallCount: result.toolCallCount, truncated: result.truncated, timedOut: result.timedOut });
      } catch (e) {
        send('turn_error', { reason: e instanceof Error ? e.message : 'unknown', recoverable: false });
      } finally {
        await releaseTurnLock(sessionId, lock.holder);
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
