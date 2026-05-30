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
import { envPositiveInt } from '@/lib/env';
import { buildSrdContext } from '@/ai/master/srd-context';
import { getMasterHandbook, getMasterWorldLore } from '@/ai/master/handbook';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';
import { deriveMode, needsSpellcastingOverlay } from '@/ai/master/mode';
import { isMechanicalIntent } from '@/ai/master/intent';
import { isBakedModel, warnIfBakedModelStale, thinkingFlagFor } from '@/ai/master/baked-models';
import { getRuntimePromptHash } from '@/ai/master/runtime-prompt-hash';
import { detectLanguage } from '@/ai/master/language';
import { runToolLoop } from '@/ai/master/tool-loop';
import { buildToolDefinitions } from '@/engine';
import { getProviderByName } from '@/ai/provider';
import { recordUsage } from '@/ai/master/usage';
import { checkQuotas } from '@/ai/master/quotas';
import { getSessionMasterPreferences, resolveMasterBackend, resolveVaultMutations, resolveDualWrite, type MasterBackend } from '@/lib/preferences';
import { runVaultToolLoop } from '@/ai/master/vault/loop';
import { buildVaultSystemPrompt } from '@/ai/master/vault/prompt-builder';
import { VAULT_TOOL_DEFINITIONS, dispatchVaultTool } from '@/ai/master/vault/tools';
import { VAULT_ROOT } from '@/ai/master/vault/path';
import { loadMemoryContext } from '@/sessions/memory/context';
import { extractMemory } from '@/sessions/memory/extractor';
import { touchCampaign } from '@/campaigns/persist';
import { computeTurnAdvance, detectAddressee } from '@/multiplayer/turn-advance';
import { notifySession } from '@/sessions/notify';
import { checkPartyAccess } from '@/multiplayer/access';
import { resolveCombatHandoff } from './combat-handoff';
import { resolveCombat, enforceResolvedNarration } from './combat-resolver';
import { parseEventsFile, replayEvents } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { buildTurnDirective, appendDirectiveToHistory, isRollResult } from '@/ai/master/vault/turn-directive';

/**
 * Synthetic user instruction injected on the very first turn of a campaign,
 * when the player has not written anything yet. Localized to the campaign
 * language so the model sees the cue in its own output distribution from
 * the first attention pass — fully-English baked SYSTEM otherwise drags
 * Italian campaigns back to English output. English is the fallback.
 */
const BEGIN_INSTRUCTION: Record<string, string> = {
  en: '[Begin the campaign now. Open the scene by narrating, in second person, the player character\'s immediate surroundings and the situation that draws them in — strictly grounded in the Campaign premise above. Voice any NPCs in earshot. Do NOT call any state-mutating tool (no add_item, award_xp, apply_damage, roll_initiative, etc.) on this opening turn — just establish the scene. End with an open-ended cue inviting the player\'s first action.]',
  it: '[Inizia la campagna ora. Apri la scena narrando, in seconda persona, ciò che il personaggio giocante percepisce nell\'ambiente circostante e la situazione che lo coinvolge — strettamente ancorato alla Premessa della campagna sopra. Dai voce a qualunque PNG a portata d\'orecchio. NON chiamare alcun tool che muta lo stato (niente add_item, award_xp, apply_damage, roll_initiative, ecc.) in questo turno di apertura — limita a stabilire la scena. Concludi con uno spunto aperto che inviti la prima azione del giocatore.]',
  es: '[Comienza la campaña ahora. Abre la escena narrando, en segunda persona, lo que el personaje jugador percibe a su alrededor y la situación que lo involucra — estrictamente anclado a la Premisa de la campaña arriba. Da voz a cualquier PNJ al alcance. NO llames a ninguna herramienta que mute el estado en este turno de apertura — solo establece la escena. Termina con un cierre abierto que invite a la primera acción del jugador.]',
  fr: '[Commence la campagne maintenant. Ouvre la scène en narrant, à la deuxième personne, ce que le personnage perçoit autour de lui et la situation qui le concerne — strictement ancrée dans la Prémisse de la campagne ci-dessus. Donne voix aux PNJ à portée. N\'appelle AUCUN outil qui mute l\'état pendant ce tour d\'ouverture — établis simplement la scène. Termine par une invite ouverte appelant la première action du joueur.]',
  de: '[Beginne die Kampagne jetzt. Eröffne die Szene, indem du in der zweiten Person erzählst, was die Spielfigur in der unmittelbaren Umgebung wahrnimmt und welche Situation sie hineinzieht — streng verankert in der obenstehenden Kampagnen-Prämisse. Verleihe etwaigen NSCs in Hörweite eine Stimme. Rufe in dieser Eröffnungsrunde KEIN zustandsänderndes Werkzeug auf — etabliere nur die Szene. Schließe mit einem offenen Hinweis, der die erste Aktion der Spielerin einlädt.]',
  pt: '[Comece a campanha agora. Abra a cena narrando, na segunda pessoa, o que o personagem percebe no entorno imediato e a situação que o envolve — estritamente ancorada na Premissa da campanha acima. Dê voz a quaisquer NPCs ao alcance. NÃO chame nenhuma ferramenta que mute o estado neste turno de abertura — apenas estabeleça a cena. Termine com um gancho aberto convidando a primeira ação do jogador.]',
};

/**
 * Mandatory tool-call instruction prefixed to the begin user message. Anchors
 * the tonal register on opening so weaker non-thinking MoE models (notably
 * qwen3:30b-a3b-instruct-2507, baked as Max 2) commit to a frame instead of
 * drifting into whatever stylistic pattern the premise pattern-matches to.
 * Paired with server-side enforcement in tool-loop.ts (requiredToolsBeforeEnd).
 * Localized for the same reason as BEGIN_INSTRUCTION above.
 */
const BEGIN_TONAL_MANDATE: Record<string, string> = {
  en: '[MANDATORY OPENING STEP] Before writing any narration, you MUST call the meta_action tool with subaction="set_tonal_frame" and a frame value exactly once. Choose the frame that best fits the campaign premise from: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. The server will reject the opening turn and re-prompt you if this tool is not called first.',
  it: '[PASSO DI APERTURA OBBLIGATORIO] Prima di scrivere qualsiasi narrazione, DEVI chiamare il tool meta_action con subaction="set_tonal_frame" e un valore frame esattamente una volta. Scegli il frame che meglio si adatta alla premessa della campagna fra: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. Il server rifiuterà il turno di apertura e ti riassegnerà il prompt se questo tool non viene chiamato per primo.',
  es: '[PASO DE APERTURA OBLIGATORIO] Antes de escribir cualquier narración, DEBES llamar al tool meta_action con subaction="set_tonal_frame" y un valor frame exactamente una vez. Elige el frame que mejor encaje con la premisa de la campaña entre: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. El servidor rechazará el turno de apertura y volverá a pedirte el prompt si esta herramienta no se llama primero.',
  fr: '[ÉTAPE D\'OUVERTURE OBLIGATOIRE] Avant d\'écrire toute narration, tu DOIS appeler le tool meta_action avec subaction="set_tonal_frame" et une valeur frame exactement une fois. Choisis le frame qui correspond le mieux à la prémisse parmi : high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. Le serveur rejettera le tour d\'ouverture si cet outil n\'est pas appelé en premier.',
  de: '[OBLIGATORISCHER ERÖFFNUNGSSCHRITT] Bevor du irgendeine Erzählung schreibst, MUSST du das Werkzeug meta_action mit subaction="set_tonal_frame" und einem frame-Wert genau einmal aufrufen. Wähle den Frame, der am besten zur Prämisse passt, aus: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. Der Server lehnt die Eröffnungsrunde ab und stellt die Anfrage erneut, wenn dieses Werkzeug nicht zuerst aufgerufen wird.',
  pt: '[PASSO DE ABERTURA OBRIGATÓRIO] Antes de escrever qualquer narração, você DEVE chamar a ferramenta meta_action com subaction="set_tonal_frame" e um valor frame exatamente uma vez. Escolha o frame que melhor combine com a premissa entre: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. O servidor rejeitará o turno de abertura se esta ferramenta não for chamada primeiro.',
};

/**
 * Build the synthetic first-turn user message. Prepends the campaign premise
 * verbatim (so the model attends to it directly — non-thinking MoE models
 * weight recent user content far more than system blocks) and stacks the
 * tonal-frame mandate ahead of the legacy BEGIN_INSTRUCTION. Both stacks are
 * picked in the campaign language when known so the model sees the cue in
 * its own output distribution, not in English.
 */
function buildBeginUserMessage(premise: string | null | undefined, language: string | null | undefined): string {
  const lang = language ?? 'en';
  const blocks: string[] = [];
  if (premise && premise.trim()) {
    blocks.push(`Campaign premise:\n\n${premise.trim()}`);
  }
  blocks.push(BEGIN_TONAL_MANDATE[lang] ?? BEGIN_TONAL_MANDATE.en!);
  blocks.push(BEGIN_INSTRUCTION[lang] ?? BEGIN_INSTRUCTION.en!);
  return blocks.join('\n\n');
}

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
        // eslint-disable-next-line no-console
        console.log('[turn]', sessionId, 'start, isBegin=', isBegin);
        // 0. Resolve session-scoped (host's) prefs once — the AI provider/model
        // and master-behavior flags MUST be uniform across the party regardless
        // of who's posting this turn. Personal-device prefs (TTS voice etc.)
        // are not consumed here; they only matter for /messages/<id>/tts which
        // resolves per-viewer.
        const userPrefs = await getSessionMasterPreferences(sessionId);
        // eslint-disable-next-line no-console
        console.log('[turn]', sessionId, 'userPrefs aiProvider=', userPrefs.aiProvider, 'model=', userPrefs.aiMasterModel);

        // Emit a turn-status notification ASAP so the client can derive the
        // right "responding" label and lock the composer. Without this the
        // client only knows a turn is in flight (via the POST 202 itself,
        // optimistic) but has no idea whether it's an opener, a cold local
        // call, or a regular warm cloud turn.
        notifySession(sessionId, {
          type: 'turn-status',
          isBegin,
          isLocalProvider: userPrefs.aiProvider === 'local',
        }).catch((e) =>
          console.warn('notifySession(turn-status) failed:', e instanceof Error ? e.message : String(e)),
        );

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
        //
        // Plan D (baked models): when aiMasterModel starts with `dnd-master-`,
        // the static prompt blocks (BASE, TOOL_CONTRACT, META_TOOLS,
        // ROLL_TRIGGERS, REWARDS_MANDATE, handbook, worldLore, MEMORY_TOOL_RULE,
        // SRD context) are already baked into the model via Modelfile SYSTEM.
        // We skip re-emitting them entirely and pass empty strings so the
        // handbook/SRD readers don't fire from disk for nothing.
        //
        // Plan C (compact prompt): for non-baked local models, when
        // `compactPrompt` is on (defaults true for local, false for cloud),
        // load the trimmed variants — fits qwen3:14b's context window without
        // losing the rules + rewards mandate.
        // ── Vault path (Phase 01 read-only + Phase 02 conditional write) ──────
        //
        // Phase 02 adds the vaultMutations opt-in. Resolution:
        //   - masterBackend === 'baked' → not vault at all (handled by the
        //     non-vault branch below); vaultMutations has no effect.
        //   - masterBackend === 'vault' + vaultMutations === false (default)
        //     → Phase 01 read-only mode: 3 tools advertised in the prompt,
        //     no campaignId forwarded to the loop, LLM-hallucinated
        //     apply_event calls return isError (dispatcher safety check).
        //   - masterBackend === 'vault' + vaultMutations === true
        //     → Phase 02 read-write mode: 4 tools advertised, campaignId
        //     forwarded, apply_event writes to events.md + regenerates view.
        //
        // Coexistence semantics (Decision 8): single-write to events.md only.
        // Postgres `characters` table is NOT touched for opted-in campaigns.
        // UI continues reading from Postgres — operator sees a stale-state
        // banner ("Vault attivo — ricarica per vedere lo stato più recente").
        // Phase 03 implements dual-write + reconciliation.
        //
        // Belt-and-suspenders: tool definitions in the loop ALWAYS include
        // all 4 entries (VAULT_TOOL_DEFINITIONS is shared with the dispatch
        // layer), but the prompt only mentions apply_event when the gate is
        // true. A misbehaving model that hallucinates apply_event against a
        // non-opted-in campaign sees a clean isError from the dispatcher
        // (campaignId presence is the runtime gate; cf. tools.ts).
        //
        // After plan 06's parallel-shape fix, `userPrefs.masterBackend` is directly typed.
        // See .planning/phases/02-vault-write-path-event-sourcing/PLAN.md.
        const masterBackend: MasterBackend = resolveMasterBackend(userPrefs.masterBackend);
        if (masterBackend === 'vault') {
          // Phase 02 gate — resolved once per turn; consumed by the prompt
          // builder (toolCount + apply_event mention) and the loop input
          // (conditional campaignId forwarding).
          const vaultMutationsEnabled = resolveVaultMutations(userPrefs);
          // Phase 03-A dual-write coexistence gate — operator-set per campaign
          // via campaign.settings.dualWrite. Orthogonal to vaultMutations in
          // theory (resolveDualWrite has no env override and doesn't gate on
          // masterBackend), but semantically meaningful ONLY when
          // vaultMutationsEnabled is true: without mutations, apply_event is
          // never invoked and the dispatcher dualWrite branch is never
          // reached. We gate on BOTH so the dispatcher sees the consistent
          // (vaultMutations true ⇒ apply_event reachable ⇒ dual-write
          // potentially active) coupling at the route boundary.
          const dualWriteEnabled = vaultMutationsEnabled && resolveDualWrite(userPrefs);
          // eslint-disable-next-line no-console
          console.log('[turn]', sessionId, 'vault path: vaultMutations=', vaultMutationsEnabled, 'dualWrite=', dualWriteEnabled);

          // 4v. Build minimal system prompt — no SRD, no handbook, no world lore,
          // no scene card, no codex, no ROLL_TRIGGERS, no REWARDS_MANDATE,
          // no meta-tools instructions. The toolCount + vaultMutations pair
          // is enforced by the builder's consistency assertion.
          const vaultSys = buildVaultSystemPrompt({
            vaultRoot: VAULT_ROOT,
            campaignId: campaign.id,
            toolCount: vaultMutationsEnabled ? 4 : 3,
            vaultMutations: vaultMutationsEnabled,
            language: campaign.language ?? snap.language ?? undefined,
            // Phase 02.1 (smoke 2026-05-26 follow-up) — inject the character
            // roster only when mutations are enabled, so read-only Phase 01
            // prompts stay byte-identical. The builder skips the section
            // when the array is empty.
            characters: vaultMutationsEnabled
              ? snap.party.map((c) => ({ id: c.id, name: c.name }))
              : undefined,
            // Phase 05 (REQ-036) — manual rolls block and DC visibility.
            manualRolls: userPrefs.manualRolls,
            showDifficultyNumbers: userPrefs.showDifficultyNumbers,
          });

          // 5v. Build history — simpler than baked (no budget truncation needed,
          // vault prompt is already small). Reuses the same HISTORY_LIMIT env var.
          let vaultHistory: Anthropic.Messages.MessageParam[];
          if (isBegin) {
            vaultHistory = [
              { role: 'user', content: buildBeginUserMessage(campaign.premise, campaign.language) },
            ];
          } else {
            const HISTORY_LIMIT = envPositiveInt('MASTER_HISTORY_LIMIT', 10);
            const recentRaw = await db
              .select()
              .from(sessionMessages)
              .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.cacheBreakpoint, false)))
              .orderBy(desc(sessionMessages.createdAt))
              .limit(HISTORY_LIMIT);
            const nameById = new Map<string, string>(snap.party.map((c) => [c.id, c.name]));
            const usePrefix = snap.party.length > 1;
            vaultHistory = recentRaw
              .reverse()
              .filter((m) => m.role !== 'system')
              .map((m) => {
                if (m.role === 'master') return { role: 'assistant', content: m.content };
                const name = usePrefix && m.authorCharacterId ? nameById.get(m.authorCharacterId) : null;
                const content = name ? `[${name}] ${m.content}` : m.content;
                return { role: 'user', content };
              });
          }

          // 5v-directive. REQ-038 — per-turn anti-anchoring directive.
          // Appended to the LAST user turn of vaultHistory (recency position)
          // so the model's most recent "instruction" breaks pattern-anchoring
          // on narration-heavy histories (validated probe 2026-05-28).
          // Null when neither vaultMutations nor manualRolls is set (read-only
          // campaigns get no directive and history stays byte-identical).
          // Player's latest message → combat-intent detection inside the
          // builder (attack verbs switch the directive to the strong
          // combat-first form). Last user turn of the assembled history.
          const _lastUserTurn = [...vaultHistory].reverse().find((m) => m.role === 'user');
          const _playerMessage =
            typeof _lastUserTurn?.content === 'string' ? _lastUserTurn.content : undefined;

          // 5v-combat (Phase 08 / REQ-039 / D-01). SERVER-SIDE COMBAT RESOLVER hook.
          // BEFORE the LLM loop, on a roll-result during an active vault encounter,
          // the server deterministically resolves hit/miss vs the monster AC, emits
          // the authoritative monster_hp_change / turn_advance events, and runs the
          // LLM narration-only. The model no longer decides the outcome.
          //
          // RESEARCH Pitfall 4: gate on the CLEAN `_playerMessage` captured ABOVE
          // (before the directive is appended at the buildTurnDirective call below),
          // so resolveCombat parses the player's original roll text — never a string
          // with the directive glued on.
          //
          // RESEARCH Pattern 3: this is an EARLY, gated read of events.md. It is a
          // DUPLICATE of the post-loop read (7v-combat) — they read the same file at
          // two different times. This early read sees the PRE-resolution encounter (to
          // decide hit/miss/target); the post-loop read sees the POST-turn_advance state
          // (so the 07-03 resolveCombatHandoff hands to the next PC). Both reads are
          // required; do NOT collapse them.
          let _resolver: ReturnType<typeof resolveCombat> = null;
          if (vaultMutationsEnabled && isRollResult(_playerMessage)) {
            try {
              const { encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
              if (encounter.active) {
                // D-01 gate satisfied (vaultMutations && active encounter && roll-result).
                // resolveCombat NEVER throws (D-05/D-10): a non-combat / unparseable /
                // ambiguous roll returns null → fall through to today's prompt path.
                _resolver = resolveCombat({ rollResult: _playerMessage!, encounter });
                if (_resolver === null) {
                  // Observability: the gate fired (active combat + roll-result) but the
                  // resolver disengaged (unparseable / wrong dice+keyword / unknown or
                  // still-ambiguous target) and silently falls through to the Phase-07
                  // prompt path. Log it — the Phase 08 duplicate-named-monster gap was
                  // hard to diagnose precisely because this fall-through was silent.
                  console.warn(
                    '[turn]', sessionId,
                    'combat-resolver fell through on a roll-result during ACTIVE combat (no server resolution) — roll:',
                    _playerMessage?.slice(0, 80),
                  );
                }
              }
            } catch (err) {
              // D-10 — never hard-fail the turn on the gate read. A read error falls
              // through to today's prompt-driven path (resolver stays null).
              console.warn(
                '[turn]', sessionId, 'combat-resolver gate read failed, falling through:',
                err instanceof Error ? err.message : String(err),
              );
            }
          }

          // EMIT (D-06 / Pattern C): when the resolver fired, emit each authoritative
          // event server-side BEFORE the loop. dispatchVaultTool validates, allocates
          // the UUID, persists to events.md, and regenerates combat.md (encounter events
          // skip the payload.character UUID guard, tools.ts:285). campaignId is the
          // SERVER campaign id — never anything player-derived (T-08-06). Wrapped
          // defensively (D-10): a dispatcher error logs + continues, never hard-fails.
          if (_resolver !== null) {
            for (const ev of _resolver.events) {
              const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
              if (r.isError) {
                console.warn('[turn]', sessionId, 'resolver emit failed:', r.content);
              }
            }
          }

          // 5v-directive. REQ-038 — per-turn anti-anchoring directive.
          // Appended to the LAST user turn of vaultHistory (recency position)
          // so the model's most recent "instruction" breaks pattern-anchoring
          // on narration-heavy histories (validated probe 2026-05-28).
          // Null when neither vaultMutations nor manualRolls is set (read-only
          // campaigns get no directive and history stays byte-identical).
          // Player's latest message → combat-intent detection inside the
          // builder (attack verbs switch the directive to the strong
          // combat-first form). Last user turn of the assembled history.
          //
          // Phase 08 (D-07): pass serverResolved so that on a server-resolved turn
          // the player-side "resolve" re-ask directive AND the combat-start directive
          // are SUPPRESSED — we must not instruct the model to emit the very
          // monster_hp_change / turn_advance events the loop is about to drop
          // (suppressCombatMutations). The server's narrationDirective (injected just
          // below) carries the combat semantics instead. When the resolver did NOT
          // fire (_resolver === null → serverResolved false), directive behavior is
          // byte-identical to Phase 07.
          const _directive = buildTurnDirective({
            vaultMutations: vaultMutationsEnabled,
            manualRolls: userPrefs.manualRolls,
            language: campaign.language ?? snap.language ?? undefined,
            ...(_playerMessage !== undefined && { playerMessage: _playerMessage }),
            serverResolved: _resolver !== null,
          });
          if (_directive !== null) {
            // Vault history elements always have string content (built by the
            // .map() call above). Cast to the narrower shape so appendDirectiveToHistory
            // can spread + reassign content without the ContentBlockParam[] union.
            vaultHistory = appendDirectiveToHistory(
              vaultHistory as { role: string; content: string }[],
              _directive,
            ) as typeof vaultHistory;
          }

          // Phase 08 (D-06 / Pattern D): on a server-resolved turn, inject the
          // resolver's narration directive into vaultHistory (recency) so the LLM
          // narrates the SERVER-determined outcome (hit/miss/-HP) in 2nd person.
          // Critical handoff from 08-02: buildTurnDirective with serverResolved:true
          // returns only a POV-only general block (it suppressed BOTH re-ask
          // catalogs), so WITHOUT this injection the LLM would get no combat
          // directive at all. appendDirectiveToHistory stacks this AFTER the general
          // directive on the same last user turn (recency wins).
          if (_resolver !== null) {
            vaultHistory = appendDirectiveToHistory(
              vaultHistory as { role: string; content: string }[],
              _resolver.narrationDirective,
            ) as typeof vaultHistory;
          }

          // 6v. Run vault tool loop.
          const vaultProvider = getProviderByName(userPrefs.aiProvider);
          const vaultMasterModel = userPrefs.aiMasterModel;
          // eslint-disable-next-line no-console
          console.log('[turn]', sessionId, 'vault path: model=', vaultMasterModel, 'tools=', VAULT_TOOL_DEFINITIONS.length);
          const vaultResult = await runVaultToolLoop({
            provider: vaultProvider,
            model: vaultMasterModel,
            systemBlocks: [{ type: 'text', text: vaultSys }],
            history: vaultHistory,
            sessionId,
            campaignLanguage: campaign.language ?? snap.language ?? undefined,
            // Phase 02 — only forward campaignId when the vaultMutations gate
            // is true. Without it, dispatchVaultTool('apply_event', ...) returns
            // isError on any LLM hallucination, preserving Phase 01 read-only
            // semantics for non-opted-in vault campaigns.
            ...(vaultMutationsEnabled && { campaignId: campaign.id }),
            // Phase 03-A — forward the dual-write flag only when the coupled
            // (vaultMutations && dualWrite) gate is true. The dispatcher then
            // routes apply_event through dualWriteApplyEvent (parallel vault +
            // Postgres + parity-check); otherwise the dispatcher preserves
            // Phase 02 single-write semantics.
            ...(dualWriteEnabled && { dualWrite: true }),
            // Phase 08 (D-06 / REQ-039 — narration-only mode). On a server-resolved
            // combat turn, DROP the LLM's combat-event apply_event calls
            // (ENCOUNTER_EVENT_TYPES) this turn — the resolver already emitted the
            // authoritative events above, so honoring the model's duplicates would
            // double-apply the damage / double-advance the turn (RESEARCH Pitfall 3,
            // T-08-04). Belt-and-suspenders with D-07 directive suppression: don't
            // ask (serverResolved), and don't honor if asked anyway (this drop).
            // Non-combat turns pass it falsy → Phase 07 behavior unchanged.
            ...(_resolver !== null && { suppressCombatMutations: true }),
            recordUsage: async (usage) => {
              await recordUsage({
                userId,
                sessionId,
                endpoint: 'master',
                model: vaultMasterModel,
                usage,
                // Vault path: no mode, no spellcasting overlay.
                // mode/needsSpellcasting are undefined → null in DB.
                mode: undefined,
                needsSpellcasting: undefined,
              });
            },
            onEvent: (ev) => {
              if (ev.type === 'narrative_delta') {
                notifySession(sessionId, { type: 'message-chunk', messageId: '', text: ev.text }).catch(
                  (e) => console.warn('notifySession(message-chunk) failed:', e instanceof Error ? e.message : String(e)),
                );
              } else if (ev.type === 'thinking') {
                notifySession(sessionId, { type: 'thinking', state: ev.state }).catch(
                  (e) => console.warn('notifySession(thinking) failed:', e instanceof Error ? e.message : String(e)),
                );
              }
            },
          });

          // 6v-enforce (Phase 08 gap fix — operator smoke 2026-05-30). On a
          // server-resolved turn the resolver is AUTHORITATIVE over the mechanical
          // channel. The local model is unreliable and COMPETES: it emits its own
          // roll-request prose ("Tira 2d6 danni …") — which the previous
          // append-if-missing safety-net DEFERRED to, so the player rolled the
          // model's malformed ask (no `danni a <target>`) and the resolver fell
          // through (no HP applied, turn never advanced) — and it leaks apply_event
          // calls as TEXT ("monster_hp_change" {…}). enforceResolvedNarration STRIPS
          // both and appends the resolver's authoritative damageRequest (hit only).
          // `_finalNarration` is used for BOTH addressee detection and persistence so
          // they stay consistent. When the resolver did not fire (_resolver === null),
          // the text is byte-identical to vaultResult.finalText.
          const _finalNarration =
            _resolver !== null
              ? enforceResolvedNarration(vaultResult.finalText, _resolver)
              : vaultResult.finalText;

          // 7v. Post-loop: turn-advance + persist master message + memory extraction.
          // Logic is identical to the baked path (same multiplayer semantics, same
          // empty-response handling). Duplicated rather than extracted to a helper
          // to keep this PR's risk surface minimal — Phase 02 may refactor.
          await db.transaction(async (tx) => {
            const [s] = await tx
              .select({ cpcId: sessions.currentPlayerCharacterId, campaignId: sessions.campaignId })
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
              // 7v-combat. Combat-interleaving: when an encounter is active,
              // derive turn handoff from EncounterState.turnOrder[currentIdx]
              // instead of prose-addressee. Falls back to the existing
              // detectAddressee/computeTurnAdvance path when the encounter is
              // inactive, turnOrder is empty, or the read fails.
              // Wrapped in try/catch: any exception in the new block falls
              // through to the existing path so non-combat sessions are safe.
              let combatHandoffDone = false;
              try {
                // Re-read the encounter state from events.md (read-only pass;
                // the loop has already committed its apply_event writes).
                const envelopes = await parseEventsFile(eventsPath(s.campaignId));
                const { encounter } = replayEvents(envelopes);
                const combatDecision = resolveCombatHandoff({ encounter, party });

                if (combatDecision.kind === 'advance') {
                  // PC turn: hand off to the PC and emit turn-change.
                  await tx
                    .update(sessions)
                    .set({ currentPlayerCharacterId: combatDecision.nextCharacterId, turnsSinceMasterAdvance: 0 })
                    .where(eq(sessions.id, sessionId));
                  await notifySession(sessionId, { type: 'turn-change', characterId: combatDecision.nextCharacterId });
                  combatHandoffDone = true;
                } else if (combatDecision.kind === 'skip') {
                  // Monster turn: the master ran it; no PC handoff needed.
                  combatHandoffDone = true;
                }
                // kind === 'fallback': fall through to detectAddressee below.
              } catch (err) {
                console.warn(
                  '[turn] combat-interleaving read failed, falling back to detectAddressee:',
                  err instanceof Error ? err.message : String(err),
                );
              }

              if (!combatHandoffDone) {
                // Fallback: existing detectAddressee / computeTurnAdvance path,
                // unchanged. This runs for non-combat sessions, inactive
                // encounters, and on any error in the combat block above.
                const addressee = detectAddressee(_finalNarration, party);
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
            }
            await tx.update(sessions).set({ turnSeq: sql`turn_seq + 1` }).where(eq(sessions.id, sessionId));
          });

          if (_finalNarration.trim()) {
            const [mm] = await db.insert(sessionMessages).values({ sessionId, role: 'master', content: _finalNarration }).returning();
            notifySession(sessionId, { type: 'message', messageId: mm!.id }).catch(
              (e) => console.warn('notifySession(message) failed:', e instanceof Error ? e.message : String(e)),
            );
            waitUntil(
              extractMemory(sessionId, userPrefs.aiProvider, vaultMasterModel).catch((e) => {
                console.error('memory.extract.fire_and_forget', e instanceof Error ? e.message : String(e));
              }),
            );
          } else {
            console.warn('turn produced empty response (vault path)', { sessionId });
            notifySession(sessionId, {
              type: 'turn-error',
              reason: 'empty_response',
              message: 'Il Master non ha prodotto una risposta. Riprova o riformula.',
            }).catch((e) => console.warn('notifySession(turn-error) failed:', e instanceof Error ? e.message : String(e)));
          }

          // Early return: baked path below is skipped on vault-flagged campaigns.
          // The outer `finally` block still runs touchCampaign + releaseTurnLock.
          return;
        }
        // ── End vault path; baked path follows ───────────────────────────────

        const baked = isBakedModel(userPrefs.aiMasterModel);
        const useCompact = !baked && userPrefs.compactPrompt;
        const srd = baked ? '' : await buildSrdContext({ compact: useCompact });
        const handbook = baked ? '' : getMasterHandbook({ compact: useCompact });
        const worldLore = baked ? '' : getMasterWorldLore({ compact: useCompact });

        // Plan D: fire-and-forget staleness check. Memoised inside —
        // logs at most one warning per (model, hash, hash) per process.
        // Never throws (the helper swallows fetch errors).
        if (baked && process.env.OLLAMA_BASE_URL) {
          const ollamaBase = process.env.OLLAMA_BASE_URL;
          void (async () => {
            try {
              // Pass the model name so the runtime hash matches the
              // per-base manifest the build script stamped (large bases
              // skip MASTER_HANDBOOK_ULTRA_SLIM, small bases keep it).
              const runtimeHash = await getRuntimePromptHash(userPrefs.aiMasterModel);
              await warnIfBakedModelStale({
                modelName: userPrefs.aiMasterModel,
                ollamaBase,
                runtimeHash,
              });
            } catch {
              /* never block a turn on this */
            }
          })();
        }
        const memory = await loadMemoryContext(sessionId, snap.scene);

        // Plan E.1: mode-aware prompt. When enabled, derive the active mode from
        // engine state + check whether the active PC is a spellcaster.
        const useModeAware = userPrefs.useModeAwarePrompt;  // already resolved by getResolvedPreferences (Task 8)
        const mode = useModeAware ? deriveMode(snap.state) : undefined;
        const needsSpellcasting = useModeAware ? needsSpellcastingOverlay(snap) : undefined;

        // Build history before the system prompt so the RAG block (Plan E.2)
        // can use recent messages as the retrieval query.
        let history: Anthropic.Messages.MessageParam[];
        if (isBegin) {
          // First-turn opener: bypass DB history (we just verified it's empty
          // upstream of this branch) and feed a single synthetic user message
          // stacked as: premise verbatim → tonal-frame mandate → begin instr.
          // Premise duplication into the user turn (also present in SYSTEM via
          // buildMasterSystemPrompt) is intentional: A3B-Instruct attends to
          // recent user content much more than to baked SYSTEM blocks. The
          // mandate and instruction are emitted in the campaign language so
          // the model's first attention pass sees the cue in its own output
          // distribution rather than in English.
          history = [{ role: 'user', content: buildBeginUserMessage(campaign.premise, campaign.language) }];
        } else {
          // History window: how many recent messages to pull. 10 = ~5 turn
          // back (user+assistant pairs).
          //
          // 2026-05-21 update: budget-aware truncation. We pull HISTORY_LIMIT
          // candidates (default 10 — preserves short-term narrative memory
          // before chapter digests kick in at message 40) and then trim
          // them down by token count IF the running total would push the
          // total prompt over a model-specific cliff.
          //
          // Why this matters: qwen3:30b-A3B (Max 2) returns empty content
          // when total input tokens exceed ~13K. Plus / cloud providers
          // happily handle 30K+. Hard-capping history at 6 saved Max 2
          // but starved continuity on every other model. The right
          // tradeoff is per-prompt: keep as much history as the model
          // can chew, drop oldest first when forced to choose.
          //
          // Continuity safety net: scene card + codex index ship every
          // turn (cover current scene); chapter digests cover history
          // older than the window once they form at ~40 messages
          // (CHAPTER_SIZE in extractor.ts).
          const HISTORY_LIMIT = envPositiveInt('MASTER_HISTORY_LIMIT', 10);
          const recentRaw = await db
            .select()
            .from(sessionMessages)
            .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.cacheBreakpoint, false)))
            .orderBy(desc(sessionMessages.createdAt))
            .limit(HISTORY_LIMIT);

          // Budget-aware truncation: keep newest messages, drop oldest until
          // the estimated history token count fits the per-model budget.
          // The fixed cost of a turn is roughly:
          //   SYSTEM baked (Modelfile, ~7000 tok)
          //   + tools array (8 meta-tools with properties, ~1500 tok)
          //   + dynamic prefix (~2000-3500 tok depending on flags)
          // Leaving ~2000-4000 tok for history before the qwen3:30b-A3B
          // empty-content cliff at ~13K total input tokens. Plus / cloud
          // providers comfortably ride 25K+, so this gate is most relevant
          // for the local-baked path.
          //
          // We can't precisely estimate the SYSTEM baked size (Ollama
          // doesn't expose it), so we use a conservative fixed envelope.
          // Char/4 is the standard rough tokens estimate for mixed EN/IT.
          const MASTER_PROMPT_BUDGET = envPositiveInt('MASTER_PROMPT_BUDGET', 12500);
          const ESTIMATED_FIXED_COST = 7000 + 1500;  // baked SYSTEM + tools
          // We don't have the rendered dynamic prefix here yet (built below
          // in step 4). Estimate it conservatively from the flags we'll set:
          // base session-stable cluster ~2400 tok + roll-triggers ~500 tok
          // when mechanical. Overshoot by 200 tok for safety.
          const ESTIMATED_DYNAMIC_COST = 2400 + 500 + 200;
          const remainingBudget = MASTER_PROMPT_BUDGET - ESTIMATED_FIXED_COST - ESTIMATED_DYNAMIC_COST;

          // recentRaw is desc (newest first). Accumulate from index 0 until
          // budget exhausted. Keep at least the most recent message no
          // matter what (worst-case the master sees only the current player
          // input — better than nothing).
          const kept: typeof recentRaw = [];
          let usedTokens = 0;
          for (const msg of recentRaw) {
            const msgTok = Math.ceil((msg.content?.length ?? 0) / 4);
            if (kept.length > 0 && usedTokens + msgTok > remainingBudget) break;
            kept.push(msg);
            usedTokens += msgTok;
          }
          // Log only when we actually truncated below the requested limit.
          if (kept.length < recentRaw.length) {
            // eslint-disable-next-line no-console
            console.log(
              '[turn]', sessionId,
              `history truncated by budget: ${kept.length}/${recentRaw.length} msgs kept (~${usedTokens}/${remainingBudget} tok)`,
            );
          }

          // In PARTY MODE the master needs to know which PG authored each
          // player message — otherwise it can't tell "I tip the guard" from
          // "Kank tips the guard". Solo mode keeps the bare content (no
          // bracket noise for a single-character session).
          const nameById = new Map<string, string>(snap.party.map((c) => [c.id, c.name]));
          const usePrefix = snap.party.length > 1;
          history = kept
            .reverse()
            .filter((m) => m.role !== 'system')
            .map((m) => {
              if (m.role === 'master') return { role: 'assistant', content: m.content };
              const name = usePrefix && m.authorCharacterId ? nameById.get(m.authorCharacterId) : null;
              const content = name ? `[${name}] ${m.content}` : m.content;
              return { role: 'user', content };
            });
        }

        // Phase 03 (vault-llm-wiki) decommissioned RAG retrieval (REQ-033).
        // The `isMechanicalIntent` heuristic survives because it still gates the
        // `injectRollTriggersSlim` block: baked models don't carry the full
        // MASTER_ROLL_TRIGGERS in their Modelfile (Plan E.1 slim manifest), so a
        // baked master on "tiro percezione" / "ispeziono il sigillo" needs the
        // SLIM block injected at runtime to keep its roll-trigger guidance.
        const lastUserText = (() => {
          const last = [...history].reverse().find((m) => m.role === 'user');
          return last && typeof last.content === 'string' ? last.content : '';
        })();
        const mechanical = isMechanicalIntent(lastUserText);

        const sys = buildMasterSystemPrompt({
          srdContext: srd,
          handbook,
          worldLore,
          characterMonoSpace: snap.characterMonoSpace,
          scene: snap.scene,
          language: campaign.language ?? snap.language,
          manualRolls: userPrefs.manualRolls,
          // Gate conditional overlays of the manual-rolls rule on the live
          // session state, so we don't ship combat-only / multiplayer-only
          // guidance on turns where it doesn't apply (saves ~430 tok and
          // ~250 tok respectively per turn — meaningful on the local path
          // where each saved token cuts prefill + speeds up tool-emission
          // on bandwidth-bound bases).
          inCombat: snap.state.combat !== null,
          partySize: snap.party?.length ?? 1,
          // Inject the brief-thinking rule only when the active model has
          // its chain-of-thought head enabled at runtime. Currently only
          // Max 3 (qwen3:30b-a3b) qualifies; everything else (Max 2
          // instruct, Plus, cloud) skips the ~120 token cost.
          thinkingEnabled: thinkingFlagFor(userPrefs.aiMasterModel) === true,
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
          // Plan B (local provider): inject meta-tools instructions block so
          // the master knows it sees 8 meta-tools (with subaction discriminator)
          // instead of the flat 72-tool list. Cloud providers keep the
          // current flat tool catalogue and skip this block.
          usesMetaTools: userPrefs.aiProvider === 'local',
          // Plan D: when the chosen local model is a baked variant
          // (dnd-master-*), skip emitting the 9 static blocks in the runtime
          // prompt — they are already inside the model's weights via
          // Modelfile SYSTEM.
          staticBlocksAlreadyBaked: baked,
          // Plan E.1: mode-aware prompt fields. When useModeAware=false they're
          // undefined and buildMasterSystemPrompt skips the mode/overlay injection
          // entirely (back-compat path).
          mode,
          needsSpellcasting,
          // Compensation for the baked-model slim manifest: baked variants
          // don't carry the full MASTER_ROLL_TRIGGERS in their Modelfile, so
          // on a "tiro percezione" / "ispeziono il sigillo" turn the master
          // would have no explicit roll-trigger guidance left. Inject the
          // SLIM block (~500 tok) only on those turns and only for baked models.
          //
          // The variant (tool-call vs manual-prose) is picked inside
          // buildMasterSystemPrompt based on `manualRolls`. We previously
          // gated this off entirely when manualRolls=true to avoid a
          // conflict with MANUAL_ROLLS_RULE (the old SLIM told the model
          // to emit a tool call which manual-rolls forbids), but that
          // left the model with no trigger map → silent narration with
          // no roll request (session 6b11f581 — "ispeziono il sigillo").
          // The new MANUAL variant resolves the conflict: it tells the
          // model to write the formula in prose, perfectly compatible
          // with MANUAL_ROLLS_RULE.
          injectRollTriggersSlim: baked && mechanical,
        });

        // 5. Run the tool loop — events forwarded to SSE subscribers via notifySession.
        // Provider + model are resolved from user prefs (with env fallback) so each
        // user can pick their own AI without redeploying.
        // eslint-disable-next-line no-console
        console.log('[turn]', sessionId, 'about to dispatch provider=', userPrefs.aiProvider);
        const provider = getProviderByName(userPrefs.aiProvider);
        // Local models can't reason effectively over the full 72-tool
        // ALWAYS_ON set inside a 40k system prompt. For local providers we
        // expose 8 meta-tools that route to the underlying handlers via
        // src/engine/tools/meta-dispatcher.ts. Cloud providers keep the
        // full 72-tool catalogue (and the system prompt skips the meta
        // instructions block via usesMetaTools=false above).
        const localOptimized = userPrefs.aiProvider === 'local';
        const tools = buildToolDefinitions(
          { imageGenerationEnabled: userPrefs.imageGenerationEnabled },
          { localOptimized },
        );
        // eslint-disable-next-line no-console
        console.log('[turn]', sessionId, 'provider resolved:', provider.name, 'calling runToolLoop with model=', userPrefs.aiMasterModel, 'tools=', tools.length, 'localOptimized=', localOptimized);
        const masterModel = userPrefs.aiMasterModel;
        const result = await runToolLoop({
          provider,
          model: masterModel,
          systemBlocks: sys.system,
          history,
          state: snap.state,
          sessionId,
          tools,
          campaignLanguage: campaign.language ?? snap.language ?? undefined,
          // First-turn enforcement: master must commit to a tonal frame
          // before narrating. The loop buffers events until the model calls
          // set_tonal_frame; if it tries to end the turn without it, the
          // buffered output is dropped and a corrective re-prompt fires.
          // One retry max. See BEGIN_TONAL_MANDATE for the priming side.
          requiredToolsBeforeEnd: isBegin ? ['set_tonal_frame'] : undefined,
          applyMutations: (muts, rolls) => applyMutations(sessionId, muts, rolls),
          recordUsage: async (usage) => {
            await recordUsage({
              userId,
              sessionId,
              endpoint: 'master',
              model: masterModel,
              usage,
              mode,
              needsSpellcasting,
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
            } else if (ev.type === 'thinking') {
              // Local streaming providers signal entry/exit of the chain-of-
              // thought phase. Frontend uses this to render a "Master is
              // thinking…" placeholder while the raw thinking tokens are
              // filtered server-side.
              notifySession(sessionId, { type: 'thinking', state: ev.state }).catch(
                (e) => console.warn('notifySession(thinking) failed:', e instanceof Error ? e.message : String(e)),
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
            // Pass the master model as fallback — local users (Ollama) don't
            // have MEMORY_EXTRACTOR_MODEL set, so without this we'd hit
            // `400: model is required` on every turn.
            extractMemory(sessionId, userPrefs.aiProvider, userPrefs.aiMasterModel).catch((e) => {
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
