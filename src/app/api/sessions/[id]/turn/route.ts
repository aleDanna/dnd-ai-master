import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, desc, isNull, isNotNull, sql } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { db } from '@/db/client';
import { sessions, sessionMessages, campaigns, characters as charactersTable } from '@/db/schema';
import { buildSnapshot } from '@/sessions/snapshot';
import { applyMutations } from '@/sessions/applicator';
import { acquireTurnLock, releaseTurnLock } from '@/sessions/lock';
import { buildSrdContext } from '@/ai/master/srd-context';
import { getMasterHandbook, getMasterWorldLore } from '@/ai/master/handbook';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';
import { detectLanguage } from '@/ai/master/language';
import { runToolLoop } from '@/ai/master/tool-loop';
import { buildToolDefinitions } from '@/engine';
import { getProviderByName } from '@/ai/provider';
import { recordUsage } from '@/ai/master/usage';
import { checkQuotas } from '@/ai/master/quotas';
import { getSessionMasterPreferences } from '@/lib/preferences';
import { loadMemoryContext } from '@/sessions/memory/context';
import { extractMemory } from '@/sessions/memory/extractor';
import { touchCampaign } from '@/campaigns/persist';
import { computeTurnAdvance, detectAddressee } from '@/multiplayer/turn-advance';
import { notifySession } from '@/sessions/notify';
import { checkPartyAccess } from '@/multiplayer/access';

/**
 * Synthetic user instruction injected on the very first turn of a campaign,
 * when the player has not written anything yet. The master sees the campaign
 * premise via the cached system block; this user message tells it to open
 * the scene now without rolling dice or mutating state. Kept in the same
 * language flavor as the rest of the system prompt — the master mirrors the
 * premise's language for the actual narration.
 */
const BEGIN_INSTRUCTION =
  '[Begin the campaign now. Open the scene by narrating, in second person, the player character\'s immediate surroundings and the situation that draws them in — strictly grounded in the Campaign premise above. Voice any NPCs in earshot. Do NOT call any state-mutating tool (no add_item, award_xp, apply_damage, roll_initiative, etc.) on this opening turn — just establish the scene. End with an open-ended cue inviting the player\'s first action.]';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return jsonResponse({ error: 'unauthenticated' }, 401);
  const { id: sessionId } = await params;
  const body = (await req.json().catch(() => null)) as { message?: string; begin?: boolean } | null;
  const isBegin = body?.begin === true;
  if (!isBegin && !body?.message?.trim()) return jsonResponse({ error: 'missing-message' }, 400);

  // Wrap the preamble (session lookup, quota, lock) so a DB connection blip
  // returns a clean JSON error instead of a bare 500. Supavisor occasionally
  // drops the first query after an idle period; an
  // unhandled rejection here would surface as "500 (Internal Server Error)"
  // in the chat UI with no recoverable signal.
  let campaign: typeof campaigns.$inferSelect;
  let lockHolder: string;
  let currentTurnSeq = 0;
  let authorCharacterId: string | null = null;
  try {
    const [turnRow] = await db
      .select({ session: sessions, campaign: campaigns })
      .from(sessions)
      .innerJoin(campaigns, eq(campaigns.id, sessions.campaignId))
      .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
      .limit(1);
    if (!turnRow) return jsonResponse({ error: 'not-found' }, 404);
    const hasAccess = await checkPartyAccess(userId, sessionId);
    if (!hasAccess) return jsonResponse({ error: 'forbidden' }, 403);
    campaign = turnRow.campaign;
    currentTurnSeq = turnRow.session.turnSeq ?? 0;
    authorCharacterId = turnRow.session.currentPlayerCharacterId ?? null;

    // Multiplayer permission check — only the current player may POST a turn.
    // Solo sessions always have currentPlayerCharacterId pointing to the
    // single character (backfilled at migration), so this check is safe for
    // solo too. Skipped on "begin" turns since the host always opens the scene.
    if (!isBegin && turnRow.session.currentPlayerCharacterId) {
      const [check] = await db
        .select({
          cpcId: sessions.currentPlayerCharacterId,
          ownerUserId: charactersTable.userId,
        })
        .from(sessions)
        .innerJoin(charactersTable, eq(charactersTable.id, sessions.currentPlayerCharacterId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!check) return jsonResponse({ error: 'session-not-found' }, 404);
      if (check.ownerUserId !== userId) {
        return jsonResponse({ error: 'not-your-turn', currentCharacterId: check.cpcId }, 403);
      }
    }

    // A "begin" turn only makes sense when the chat is empty. If anything
    // has been said already, ignore the flag silently — clients may
    // re-trigger the auto-opener on remount and we don't want that to
    // duplicate the intro.
    if (isBegin) {
      const [existing] = await db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId))
        .limit(1);
      if (existing) return jsonResponse({ error: 'already-begun' }, 409);
    }

    const quota = await checkQuotas({ userId });
    if (!quota.ok) return jsonResponse({ error: quota.reason }, 429);

    const lock = await acquireTurnLock(sessionId);
    if (!lock.acquired) return jsonResponse({ error: 'turn_in_progress' }, 409);
    lockHolder = lock.holder;
  } catch (e) {
    return jsonResponse(
      { error: 'preamble_failed', reason: e instanceof Error ? e.message : 'unknown' },
      503,
    );
  }

  // Run the master loop in the background so the HTTP response can return
  // 202 immediately. Clients receive real-time updates via the /stream SSE
  // channel (Tasks 20-22). The SSE response and `send()` helper are removed;
  // all events now flow through notifySession / pg_notify.
  waitUntil(
    (async () => {
      try {
        // 0. Resolve session-scoped (host's) prefs once — the AI provider/model
        // and master-behavior flags MUST be uniform across the party regardless
        // of who's posting this turn. Personal-device prefs (TTS voice etc.)
        // are not consumed here; they only matter for /messages/<id>/tts which
        // resolves per-viewer.
        const userPrefs = await getSessionMasterPreferences(sessionId);

        // 1. Persist player message — skipped on the synthetic "begin" turn
        // (no real player text exists yet; the master is opening the scene
        // from the campaign premise).
        if (!isBegin) {
          await db.insert(sessionMessages).values({
            sessionId,
            role: 'player',
            content: body!.message!,
            // Multiplayer: tag which character authored this message so
            // the chat bubbles can show the character name instead of "Player".
            authorCharacterId: authorCharacterId ?? undefined,
          });
        }

        // 2. Language detection if not pinned (uses the user's chosen provider).
        // On a begin turn we have no player text, so we run detection on the
        // premise itself — that way the master mirrors the language the
        // player wrote (or the preset's language) right out of the gate.
        // language is canonical on the campaign row.
        if (!campaign.language) {
          const detectText = isBegin ? campaign.premise : body!.message!;
          if (detectText && detectText.trim().length > 0) {
            const code = await detectLanguage({ text: detectText, userId, sessionId, provider: userPrefs.aiProvider });
            if (code) {
              await db.update(campaigns).set({ language: code }).where(eq(campaigns.id, campaign.id));
              // Propagate into the in-memory campaign object so the system
              // prompt receives the freshly detected language below.
              campaign.language = code;
            }
          }
        }

        // 3. Build snapshot
        const snap = await buildSnapshot(sessionId, userId);

        // 4. Build system prompt + history
        const srd = await buildSrdContext();
        const handbook = getMasterHandbook();
        const worldLore = getMasterWorldLore();
        const memory = await loadMemoryContext(sessionId, snap.scene);
        const sys = buildMasterSystemPrompt({
          srdContext: srd,
          handbook,
          worldLore,
          characterMonoSpace: snap.characterMonoSpace,
          scene: snap.scene,
          language: campaign.language ?? snap.language,
          manualRolls: userPrefs.manualRolls,
          masterGuidanceLevel: userPrefs.masterGuidanceLevel,
          showDifficultyNumbers: userPrefs.showDifficultyNumbers,
          narrationPace: userPrefs.narrationPace,
          chapterDigests: memory.chapterDigests,
          sceneCard: memory.sceneCard,
          codexIndex: memory.codexIndex,
          // Master World Lore §5.1 + Master Handbook §2.1 — pass through the
          // campaign-level tonal frame and engagement profile so the system
          // prompt can inject the dynamic blocks when set.
          // (Hydrated from the campaign join in buildSnapshot since Task 15.)
          tonalFrame: snap.state.tonalFrame,
          engagementProfile: snap.state.engagementProfile,
          // Multiplayer — party roster + active player for PARTY MODE block.
          party: snap.party,
          currentPlayerCharacterId: snap.currentPlayerCharacterId,
        });

        let history: Anthropic.Messages.MessageParam[];
        if (isBegin) {
          // First-turn opener: bypass DB history (we just verified it's empty
          // upstream of this branch) and feed a single synthetic user
          // instruction so the model has something to respond to.
          history = [{ role: 'user', content: BEGIN_INSTRUCTION }];
        } else {
          const recent = await db
            .select()
            .from(sessionMessages)
            .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.cacheBreakpoint, false)))
            .orderBy(desc(sessionMessages.createdAt))
            .limit(20);
          // In PARTY MODE the master needs to know which PG authored each
          // player message — otherwise it can't tell "I tip the guard" from
          // "Kank tips the guard". Solo mode keeps the bare content (no
          // bracket noise for a single-character session).
          const nameById = new Map<string, string>(snap.party.map((c) => [c.id, c.name]));
          const usePrefix = snap.party.length > 1;
          history = recent
            .reverse()
            .filter((m) => m.role !== 'system')
            .map((m) => {
              if (m.role === 'master') return { role: 'assistant', content: m.content };
              const name = usePrefix && m.authorCharacterId ? nameById.get(m.authorCharacterId) : null;
              const content = name ? `[${name}] ${m.content}` : m.content;
              return { role: 'user', content };
            });
        }

        // 5. Run the tool loop — events forwarded to SSE subscribers via notifySession.
        // Provider + model are resolved from user prefs (with env fallback) so each
        // user can pick their own AI without redeploying.
        const provider = getProviderByName(userPrefs.aiProvider);
        const masterModel = userPrefs.aiMasterModel;
        const tools = buildToolDefinitions({ imageGenerationEnabled: userPrefs.imageGenerationEnabled });
        const result = await runToolLoop({
          provider,
          model: masterModel,
          systemBlocks: sys.system,
          history,
          state: snap.state,
          sessionId,
          tools,
          applyMutations: (muts, rolls) => applyMutations(sessionId, muts, rolls),
          recordUsage: async (usage) => {
            await recordUsage({
              userId,
              sessionId,
              endpoint: 'master',
              model: masterModel,
              usage,
            });
          },
          onEvent: (ev) => {
            // Broadcast narrative chunks to all SSE subscribers on the session
            // channel so party members receive the master typing in real-time.
            // messageId:'' is a sentinel meaning "pending" — the real messageId
            // arrives in the 'message' notification once the row is persisted.
            if (ev.type === 'narrative_delta') {
              notifySession(sessionId, { type: 'message-chunk', messageId: '', text: ev.text }).catch(
                (e) => console.warn('notifySession(message-chunk) failed:', e instanceof Error ? e.message : String(e)),
              );
            }
          },
        });

        // 6. Post-loop turn advancement.
        //
        // We previously used `tool_use_start` for `set_current_player` as the
        // signal that the master had advanced the turn. That signal lies in
        // two real cases: the handler can reject the call (Gemini Flash
        // sometimes passes a character name instead of the uuid) and the
        // master can no-op the call by re-targeting the current player.
        // Both leave the DB state untouched but `tool_use_start` still fires,
        // so the fallback was suppressed and players got stuck on the prior
        // actor's bubble.
        //
        // Source of truth is the DB instead: if cpcId still equals the
        // author's cpcId after the loop, the master did not actually advance
        // — round-robin to break the deadlock. See computeTurnAdvance for
        // the full case breakdown (solo, begin turns, etc.).
        await db.transaction(async (tx) => {
          const [s] = await tx
            .select({
              cpcId: sessions.currentPlayerCharacterId,
              campaignId: sessions.campaignId,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (s && s.campaignId) {
            const party = await tx
              .select({ id: charactersTable.id, name: charactersTable.name, createdAt: charactersTable.createdAt })
              .from(charactersTable)
              .where(and(
                eq(charactersTable.campaignId, s.campaignId),
                isNull(charactersTable.deletedAt),
                isNotNull(charactersTable.templateId),
              ))
              .orderBy(charactersTable.createdAt);
            // Prose-derived addressee: scans the whole message for
            // "<Name>," patterns at sentence boundaries. Catches both
            // POV-opening addresses ("Kank Reena, le parole...") and
            // closing-prompt addresses ("Kank, cosa fai?"). When the
            // master writes either form, the system trusts the prose over
            // the tool layer.
            const addressee = detectAddressee(result.finalText, party);
            const decision = computeTurnAdvance({
              isBegin,
              beforeCpcId: authorCharacterId,
              afterCpcId: s.cpcId,
              party,
              addresseeId: addressee?.id ?? null,
            });
            if (decision.kind === 'advance') {
              await tx
                .update(sessions)
                .set({ currentPlayerCharacterId: decision.nextCharacterId, turnsSinceMasterAdvance: 0 })
                .where(eq(sessions.id, sessionId));
              await notifySession(sessionId, { type: 'turn-change', characterId: decision.nextCharacterId });
            }
          }
          // Bump turnSeq for downstream consumers (cache keys, etc.).
          await tx.update(sessions).set({ turnSeq: sql`turn_seq + 1` }).where(eq(sessions.id, sessionId));
        });

        // 7. Persist master message — only if it actually has content. An
        // empty finalText typically means a tool call failed and the master
        // never got to write narration; persisting an empty row leaves a
        // ghost "THE MASTER" bubble in the chat with no body.
        if (result.finalText.trim()) {
          const [mm] = await db.insert(sessionMessages).values({ sessionId, role: 'master', content: result.finalText }).returning();
          // Notify SSE subscribers that a final master message is persisted.
          // This supersedes all preceding message-chunk notifications for this
          // turn — clients should replace their transient buffer with the row.
          notifySession(sessionId, { type: 'message', messageId: mm!.id }).catch(
            (e) => console.warn('notifySession(message) failed:', e instanceof Error ? e.message : String(e)),
          );
          waitUntil(
            extractMemory(sessionId, userPrefs.aiProvider).catch((e) => {
              console.error('memory.extract.fire_and_forget', e instanceof Error ? e.message : String(e));
            }),
          );
        } else {
          // Gemini / brief-mode responses sometimes only call tools and
          // `end_turn` without producing narration. The turn DID happen
          // (tools ran, mutations persisted, turn counter advanced), but the
          // player has nothing to read and no signal that the master tried.
          // Surface this to the client as a `turn-error` so the composer
          // unlocks and the player can re-prompt the master.
          console.warn('turn produced empty response', { sessionId });
          notifySession(sessionId, {
            type: 'turn-error',
            reason: 'empty_response',
            message: 'Il Master non ha prodotto una risposta. Riprova o riformula.',
          }).catch((e) => console.warn('notifySession(turn-error) failed:', e instanceof Error ? e.message : String(e)));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error('turn background task failed', reason);
        // Surface the failure to the client so it stops waiting forever.
        // We intentionally do NOT echo the raw error to the user — it
        // could leak provider keys or internal details — just a generic
        // hint that the turn fizzled. The full reason stays in the logs.
        notifySession(sessionId, {
          type: 'turn-error',
          reason: 'failed',
          message: 'Il Master ha incontrato un errore. Riprova.',
        }).catch((nerr) =>
          console.warn('notifySession(turn-error/failed) failed:', nerr instanceof Error ? nerr.message : String(nerr)),
        );
      } finally {
        await touchCampaign(campaign.id);
        await releaseTurnLock(sessionId, lockHolder);
      }
    })(),
  );

  return NextResponse.json({ ok: true, turnSeq: currentTurnSeq + 1 }, { status: 202 });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
