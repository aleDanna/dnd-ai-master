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
import { resolveCombat, enforceResolvedNarration, canonicalizeToHitTarget, stripLeakedMechanics, isNarrationOnlyTurn, parseAttackRollTarget, type ResolveCombatResult } from './combat-resolver';
import { runMonsterTurnLoop } from './monster-turns';
import { getBestiaryAttackStats, getBestiaryStatblock } from './monster-bestiary';
import { runEncounterOpener, extractMonsterName } from './encounter-opener';
import { parseEventsFile, replayEvents } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { buildTurnDirective, appendDirectiveToHistory, isRollResult, detectCombatIntent, isCombatDeclaration } from '@/ai/master/vault/turn-directive';
import { buildBeginUserMessage } from '@/ai/master/begin-message';

// buildBeginUserMessage moved to @/ai/master/begin-message (shared baked+vault).
// The vault begin call passes { tonalMandate: false } — the vault path has no
// meta_action tool / tonalFrame / requiredToolsBeforeEnd enforcement, so the
// mandate only made local models emit the tool call as text and stall the open.

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
              // tonalMandate:false — the vault path has no meta_action tool /
              // tonalFrame / requiredToolsBeforeEnd enforcement, so the mandate
              // only makes local models emit `meta_action: {...}` as text and
              // stall the opener. Vault begin is narration-only (offerTools:false).
              { role: 'user', content: buildBeginUserMessage(campaign.premise, campaign.language, { tonalMandate: false }) },
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

          // 5v-opener (Phase 10 / REQ-045 / D-01). SERVER-AUTHORITATIVE ENCOUNTER
          // OPENER hook. BEFORE the v1 resolver gate, on a real player turn where
          // combat intent is detected AND no encounter is active AND the message is
          // NOT a roll-result, the server deterministically opens the encounter
          // (monster_spawn + initiative_set) via the pure runEncounterOpener helper
          // (10-01) with the real SRD bestiary reader (10-02) injected as the lookup.
          //
          // Gate ordering: isRollResult is checked BEFORE detectCombatIntent because
          // a roll-result message echoes the attack verb (e.g. "attaccare Goblin")
          // and would otherwise re-trip detectCombatIntent → re-open an already-
          // active encounter (REQ-047 sequencing invariant + loop-avoidance).
          //
          // Monster-name derivation: Option B (CONTEXT.md LOCKED) — extract the
          // likely target name from the player message by stripping common attack-
          // verb prefixes and keeping the remainder. This step is intentionally
          // isolated in _extractMonsterName so the future option-A constrained-JSON
          // path can replace ONLY this step without touching the opener call or
          // dispatch loop.
          //
          // Async/sync bridge: getBestiaryStatblock is async (it awaits readVaultFile
          // on the vault filesystem); runEncounterOpener is pure/synchronous. We
          // pre-await the statblock, then inject a synchronous closure () => stats so
          // the opener contract is satisfied and the REAL bestiary values reach the
          // opener (goblin → hpMax 7 from SRD, not a CR-default).
          //
          // openerRan (cross-plan signal): declared at the vault-branch scope
          // alongside _resolver and _monsterLoopRan so the empty-narration guard
          // in the 10-04 notify branch can read it (combatStateChanged = _resolver
          // !== null || _monsterLoopRan || openerRan).
          // Turn-start encounter snapshot (Phase 07 hotfix). Read ONCE so the
          // offerTools gate below can keep the master narration-only during ANY
          // active encounter — not just the turns detectCombatIntent catches. A
          // weak-tool narration model (gemma4) leaks markerless CoT whenever it
          // is handed apply_event and the server resolver MISSES (e.g. an
          // unmatched / bare target name like "danni a goblin" drops the turn to
          // the LLM, which then reasons aloud about how to call the tool). The
          // server still owns every combat mutation; the model only narrates.
          let _encounterActive = false;
          if (vaultMutationsEnabled) {
            try {
              _encounterActive = replayEvents(await parseEventsFile(eventsPath(campaign.id))).encounter.active;
            } catch {
              // No events.md yet (brand-new campaign) → not in combat.
            }
          }

          let openerRan = false;
          if (!isBegin && vaultMutationsEnabled && detectCombatIntent(_playerMessage) && !isRollResult(_playerMessage)) {
            try {
              const { encounter: encounterForOpener } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
              if (!encounterForOpener.active) {
                // Option B monster-name extraction: trim common attack-verb prefixes
                // from the player message and use the remainder as the monster name.
                // Heuristic — the intent signal (combat verb) is already confirmed;
                // we pick the nominal target as the first non-verb word group.
                // This seam is intentionally isolated: option A (constrained-JSON
                // Ollama format call) will replace ONLY the _extractMonsterName step.
                // Monster-name extraction is an isolated, unit-tested seam in
                // encounter-opener.ts (extractMonsterName) — option A will
                // replace ONLY that step. It strips the multi-PC `[Author]`
                // history prefix (CR-01) and IT/EN articles (WR-01) before
                // picking the nominal target.
                const monsterName = extractMonsterName(_playerMessage ?? '');

                // Pre-await the async statblock, then inject a sync closure so
                // runEncounterOpener (pure/sync contract) reads the REAL SRD values.
                // This bridges the async getBestiaryStatblock → sync bestiaryLookup
                // seam: goblin → { hpMax: 7, ac: 15, cr: '1/4' } from the vault FS.
                // INFO-9: snap.party rows carry no initiativeBonus/initiative field
                // (characters schema has ac/hpMax only) — PC initiative is 1d20+0 by
                // design inside the opener; not dropped wiring.
                const _bestiaryStats = await getBestiaryStatblock(monsterName);
                // Scatto-guard: getBestiaryStatblock returns null for an unknown name —
                // almost always a mis-extraction (a leading verb/pronoun when the player
                // named NO creature, e.g. "scatto prima di lui e lo attacco" → "scatto").
                // Skip the spawn so we never materialize a junk monster (garbage name,
                // ac undefined); the master just narrates. NOTE: this requires combat
                // monsters to be defined in the SRD bestiary (data/vault/handbook/monsters).
                if (_bestiaryStats === null) {
                  console.warn('[turn]', sessionId, 'opener skipped — unknown/unnamed monster (not in bestiary):', monsterName);
                }
                const openerEvents = _bestiaryStats === null ? [] : runEncounterOpener(snap, monsterName, () => _bestiaryStats);

                for (const ev of openerEvents) {
                  // Pass BOTH campaignId (server UUID, never player-derived — T-10-07)
                  // AND sessionId so emitStateRefresh fires in production (tools.ts:200)
                  // and the combat tracker refreshes client-side. Mirror the v1 emit
                  // loop pattern (route.ts ~381-383).
                  const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id, sessionId });
                  if (r.isError) {
                    console.warn('[turn]', sessionId, 'encounter opener emit failed:', r.content);
                  }
                }

                // openerRan: cross-plan boolean signal for 10-04's empty-narration
                // guard (combatStateChanged = _resolver !== null || _monsterLoopRan
                // || openerRan). Set AFTER dispatch so it is true only on success.
                if (openerEvents.length > 0) {
                  openerRan = true;
                }
              }
            } catch (err) {
              // D-10 / T-10-09 — never hard-fail the turn on an opener error.
              // Log + fall through; openerRan stays false → turn continues as
              // a normal non-combat vault turn (narrative path).
              console.warn(
                '[turn]', sessionId, 'encounter opener failed, falling through:',
                err instanceof Error ? err.message : String(err),
              );
            }
          }

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
              let { encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
              // 5v-master-opener (autonomous-master / real-combat). A to-hit roll
              // arrived with NO active encounter — the master narrated a fight and
              // asked for the roll WITHOUT the player declaring an attack, so the
              // player-declaration opener (5v-opener) never fired. Open an encounter
              // for the rolled target so the roll resolves with REAL HP/turns instead
              // of falling through to the tool-handed LLM (which melts down). Spawn
              // under the EXACT rolled name so resolveCombat's matchMonster aligns;
              // bestiary stats come from the base species (number suffix stripped).
              // KNOWN LIMIT: only the attacked target is materialized — a multi-enemy
              // fight the master narrated in prose stays fiction for the others.
              if (!encounter.active) {
                const _mTarget = parseAttackRollTarget(_playerMessage ?? '');
                if (_mTarget) {
                  try {
                    const _mBase = _mTarget.replace(/[\s\-_#]+\d+\s*$/, '').trim() || _mTarget;
                    const _mStats = await getBestiaryStatblock(_mBase);
                    // Scatto-guard (see player opener): no junk monster when the rolled
                    // target isn't a known bestiary monster.
                    if (_mStats === null) {
                      console.warn('[turn]', sessionId, 'master-initiated opener skipped — unknown monster (not in bestiary):', _mTarget);
                    }
                    const _mOpenerEvents = _mStats === null ? [] : runEncounterOpener(snap, _mTarget, () => _mStats);
                    for (const ev of _mOpenerEvents) {
                      const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id, sessionId });
                      if (r.isError) {
                        console.warn('[turn]', sessionId, 'master-initiated opener emit failed:', r.content);
                      }
                    }
                    if (_mOpenerEvents.length > 0) {
                      openerRan = true;
                      ({ encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id))));
                      console.log('[turn]', sessionId, 'master-initiated opener spawned', _mTarget, '→ active=', encounter.active);
                    }
                  } catch (e) {
                    console.warn(
                      '[turn]', sessionId, 'master-initiated opener failed, falling through:',
                      e instanceof Error ? e.message : String(e),
                    );
                  }
                }
              }
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
              // Phase 04 SSE hand-off — pass sessionId so each server-resolved
              // emission drives a `state` UI refresh independently of the
              // Postgres applicator (which won't run post-legacy-drop).
              const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id, sessionId });
              if (r.isError) {
                console.warn('[turn]', sessionId, 'resolver emit failed:', r.content);
              }
            }
          }

          // 5v-monster (Phase 09 / D-01..D-16). SERVER-SIDE MONSTER-TURN LOOP hook.
          // Runs IMMEDIATELY AFTER the v1 player resolution + post-turn turn_advance
          // (the COMMON path is: player attacks → v1 resolver fires → the turn
          // advances to a monster → the loop runs, BOTH in the SAME request, D-01).
          // Reads the post-v1 EncounterState; if the active actor is a LIVE monster
          // (vaultMutations && encounter.active gate, D-01), runs runMonsterTurnLoop
          // (09-04) to resolve consecutive monster turns server-side, emitting each
          // hp_change / turn_advance via the SAME dispatchVaultTool('apply_event', ...)
          // pattern as the v1 resolver (D-13), OUTSIDE the DB transaction (RESEARCH
          // Anti-Pattern: never run the loop inside db.transaction). The whole block
          // is wrapped defensively (D-10 / T-09-19): a failure resolves to "no monster
          // actions" and never hard-fails the player's turn.
          let _monsterLoopRan = false;
          let _monsterNarration: string | null = null;
          if (vaultMutationsEnabled) {
            try {
              // Post-v1 encounter read (Pattern 5). Same replay used by the v1 gate;
              // the chars map carries per-character CURRENT HP (projector: "PC HP
              // comes from the per-character CharacterState"), which EncounterState
              // does NOT (RESEARCH Pitfall 1 / Open Q1).
              const { encounter, chars } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
              const activeEntry =
                encounter.active && encounter.turnOrder.length > 0
                  ? encounter.turnOrder[encounter.currentIdx]
                  : undefined;
              const activeMonster = activeEntry
                ? encounter.monsters.find((m) => m.id === activeEntry.actorId && m.isAlive)
                : undefined;
              if (activeMonster) {
                // D-12 PC-AC bridge: build Map<pcId, ac> from a targeted {id, ac}
                // select on charactersTable (characters.ac is notNull → no default).
                // PC current HP comes from the replay chars map (D-11/D-14 live-target
                // filter), falling back to the characters-row hpMax when a PC is
                // absent from the chars map (defensive). Map ONLY party PC UUIDs.
                const pcRows = await db
                  .select({ id: charactersTable.id, ac: charactersTable.ac, hpMax: charactersTable.hpMax })
                  .from(charactersTable)
                  .where(and(
                    eq(charactersTable.campaignId, campaign.id),
                    isNull(charactersTable.deletedAt),
                    isNotNull(charactersTable.templateId),
                  ));
                const pcAcById = new Map<string, number>();
                const pcHpById = new Map<string, number>();
                for (const pc of pcRows) {
                  pcAcById.set(pc.id, pc.ac);
                  const replayed = chars.get(pc.id);
                  pcHpById.set(pc.id, replayed ? replayed.hp_current : pc.hpMax);
                }

                // Run the loop with the real fs-backed bestiary lookup (09-03). The
                // loop is pure/headless and NEVER throws; it returns the events to
                // persist + the ONE combined narration directive (D-15).
                const loop = await runMonsterTurnLoop({
                  encounter,
                  pcAcById,
                  pcHpById,
                  bestiaryLookup: getBestiaryAttackStats,
                });

                // Emit each loop event server-side (D-13), mirroring the v1 emit loop —
                // OUTSIDE the DB transaction. campaignId is the SERVER campaign id,
                // never player-derived (T-09-18).
                for (const ev of loop.events) {
                  // Phase 04 SSE hand-off — pass sessionId so monster-turn
                  // emissions refresh the UI on the vault path (post-legacy-drop
                  // the Postgres applicator no longer fires the `state` event).
                  const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id, sessionId });
                  if (r.isError) {
                    console.warn('[turn]', sessionId, 'monster-turn emit failed:', r.content);
                  }
                }

                // Ran iff the loop actually resolved monster turns (D-01). On a
                // pc-turn / empty stop with no results, _monsterLoopRan stays false
                // and the turn behaves exactly as the player-only path.
                _monsterLoopRan = loop.results.length > 0;
                _monsterNarration = loop.narrationDirective;
              }
            } catch (err) {
              // Defensive (D-10 / T-09-19): a loop failure resolves to "no monster
              // actions" and must NEVER hard-fail the player's turn.
              console.warn(
                '[turn]', sessionId, 'monster-turn loop failed, falling through:',
                err instanceof Error ? err.message : String(err),
              );
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
            // Phase 09 (D-16): on a server-resolved MONSTER turn the loop already
            // emitted the authoritative events; suppress the combat re-ask
            // directives (mirrors serverResolved). The combined monster directive
            // injected below governs the narration instead.
            monsterResolved: _monsterLoopRan,
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

          // Phase 09 (D-15 / D-01): on a server-resolved MONSTER turn, inject the
          // loop's ONE combined narration directive (built once by the loop) so the
          // LLM narrates ALL monster outcomes in a SINGLE pass. Same recency-stacking
          // mechanism as the v1 resolver injection above; on the common path where a
          // player attack ALSO resolved this turn, this stacks AFTER the player
          // directive so the combined monster outcome wins the recency position.
          if (_monsterLoopRan && _monsterNarration) {
            vaultHistory = appendDirectiveToHistory(
              vaultHistory as { role: string; content: string }[],
              _monsterNarration,
            ) as typeof vaultHistory;
          }

          // 6v. Run vault tool loop.
          const vaultProvider = getProviderByName(userPrefs.aiProvider);
          const vaultMasterModel = userPrefs.aiMasterModel;
          // eslint-disable-next-line no-console
          console.log('[turn]', sessionId, 'vault path: model=', vaultMasterModel, 'tools=', VAULT_TOOL_DEFINITIONS.length);
          const _vaultLoopInput: Parameters<typeof runVaultToolLoop>[0] = {
            provider: vaultProvider,
            model: vaultMasterModel,
            systemBlocks: [{ type: 'text', text: vaultSys }],
            history: vaultHistory,
            sessionId,
            campaignLanguage: campaign.language ?? snap.language ?? undefined,
            // Narration-only (no tools). TWO cases:
            //  - Begin-turn: nothing to read/mutate on the opener; local models (qwen3)
            //    handed the vault tools reach for one (list_vault) instead of narrating
            //    → empty content → "turn produced empty response" → stuck UI.
            //  - Server-owned COMBAT turn (Phase 08-05): the opener/resolver/monster-loop
            //    already did the mechanics, so the model must ONLY narrate. A weak model
            //    handed apply_event on a combat turn re-emits combat_start (WIPING the
            //    server-set encounter) and loops on malformed calls until the lock TTL
            //    (gemma4:12b, 2026-06-04). offerTools:false removes that footgun; the
            //    to-hit request is appended server-side (6v) and the resolver/loop own the
            //    events. suppressCombatMutations below stays as belt-and-suspenders.
            ...(isNarrationOnlyTurn({
                isBegin,
                vaultMutationsEnabled,
                encounterActive: _encounterActive,
                isCombatDeclaration: isCombatDeclaration(_playerMessage),
                isRollResult: isRollResult(_playerMessage),
                resolverFired: _resolver !== null,
                monsterLoopRan: _monsterLoopRan,
              }) && { offerTools: false }),
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
            // Phase 09 (D-16): also drop combat apply_event calls on a server-resolved
            // MONSTER turn — the loop already emitted the authoritative hp_change /
            // turn_advance events, so honoring the model's duplicates would
            // double-apply damage / double-advance the turn (T-09-20). Extends the v1
            // gate to (player-resolved OR monster-loop-ran).
            ...((_resolver !== null || _monsterLoopRan) && { suppressCombatMutations: true }),
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
          };
          let vaultResult = await runVaultToolLoop(_vaultLoopInput);
          // Empty-narration retry. gemma4 intermittently returns NO content on a
          // turn (operator: "il master non ha prodotto risposta" — the turn dies
          // with 0 messages). Retry the loop ONCE on a GENUINE empty: no server
          // combat events fired this turn (a resolver/opener/monster turn can
          // legitimately narrate empty and is handled by the empty-narration guard
          // below — retrying those would risk double-narrating a resolved beat).
          if (!vaultResult.finalText.trim() && _resolver === null && !_monsterLoopRan && !openerRan) {
            console.warn('[turn]', sessionId, 'empty narration — retrying the master loop once');
            vaultResult = await runVaultToolLoop(_vaultLoopInput);
          }

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
          //
          // Phase 09 (W3 / D-01 / D-16 — CORRECTNESS-CRITICAL): bind the FINAL
          // narration via enforceResolvedNarration whenever the monster loop ran
          // (`_monsterLoopRan`), regardless of `_resolver`. Per D-01 the COMMON path
          // is player-attack-resolves AND monster-loop-runs in the SAME request
          // (BOTH _resolver != null AND _monsterLoopRan), and the combined monster
          // directive (D-15) governs that final pass — so the binding must NOT be
          // gated on `_resolver` alone, or the monster path would leak the model's
          // competing roll-asks / event-JSON. The monster path passes a
          // ResolveCombatResult-shaped object with `damageRequest: null` (the monster
          // sequence has no single settled damage-request); enforceResolvedNarration
          // then only strips leaked roll-asks / event-JSON and appends nothing.
          let _finalNarration: string;
          if (_monsterLoopRan) {
            // Build a ResolveCombatResult-shaped object for the monster path. Only
            // the strip logic is wanted here: `damageRequest: null` means
            // enforceResolvedNarration appends nothing and merely removes leaked
            // roll-asks / event-JSON. The `events` field carries the loop's emitted
            // events (already persisted above; passed for shape completeness — the
            // enforcer does not re-emit). The narration semantics come from the
            // combined monster directive (D-15) injected into vaultHistory.
            const _monsterResolved = {
              kind: 'resolved',
              events: [],
              narrationDirective: _monsterNarration ?? '',
              damageRequest: null,
            } as unknown as ResolveCombatResult;
            _finalNarration = enforceResolvedNarration(vaultResult.finalText, _monsterResolved);
          } else if (_resolver !== null) {
            _finalNarration = enforceResolvedNarration(vaultResult.finalText, _resolver);
          } else {
            // 6v-canonicalize (Phase 08-03 / REQ-039 extension). On a combat
            // DECLARATION turn (encounter active, player declares attack intent,
            // but no roll-result yet), canonicalize the master's to-hit request
            // target to the canonical (numbered) monster name derived from the
            // PLAYER's message. This prevents qwen3 from writing a prose
            // descriptor as the attack target (e.g. "il Pirata di Buggy con il
            // naso enorme") instead of the exact tracker name ("Pirata di Buggy 1")
            // — which would make the subsequent roll label unresolvable.
            //
            // Gate: vaultMutations && detectCombatIntent && !isRollResult
            //   (same gate as the encounter opener — declaration turn).
            //   Skipped when: encounter inactive, ambiguous/unknown player target,
            //   no "Tira … 1d20 …" line present. Falls through to vaultResult.finalText
            //   on any error (D-10: never hard-fail the turn).
            //
            // Reads events.md once (separate from the 5v-combat read) to avoid
            // closing-over a stale encounter state from the opener block.
            // Phase 08-04 — server-OWNED combat narration. On a PC attack DECLARATION
            // (active combat, combat intent, not a roll-result) the server OWNS the
            // to-hit request: canonicalizeToHitTarget rewrites the model's target to the
            // canonical numbered name AND appends a canonical "Tira 1d20 per attaccare
            // <name>" if the model wrote none, stripping leaked apply_event prose — so the
            // player ALWAYS gets a resolvable roll button. On any OTHER active-combat turn
            // (incl. a roll-result the resolver could not match), stripLeakedMechanics
            // removes leaked apply_event TEXT so raw mechanics never reach the player.
            let _ft = vaultResult.finalText;
            if (vaultMutationsEnabled && _playerMessage !== undefined) {
              try {
                const { encounter: _declEnc } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
                if (_declEnc.active) {
                  _ft = (detectCombatIntent(_playerMessage) && !isRollResult(_playerMessage))
                    ? canonicalizeToHitTarget(_ft, _playerMessage, _declEnc)
                    : stripLeakedMechanics(_ft);
                }
              } catch (err) {
                // D-10: a read/replay error falls through to the unmodified text.
                console.warn(
                  '[turn]', sessionId, '6v combat-narration guard failed, falling through:',
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
            _finalNarration = _ft;
          }

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
            // REQ-046 empty-narration guard (10-04): when a server-authoritative
            // combat turn ran (resolver fired / monster loop ran / opener ran) but
            // produced no narration, the turn LEGITIMATELY ADVANCED STATE — HP
            // changed, initiative moved, an encounter opened. Emitting the normal
            // {type:'turn-error'} notify here would trigger a spurious "no response /
            // retry" toast even though the turn succeeded. Instead, emit a silent
            // {type:'state'} notify so the client refetches and the tracker updates
            // with NO error toast.
            //
            // Only the GENUINE non-combat empty case (all three signals falsy — a
            // real model failure) keeps the original {type:'turn-error'} emit so
            // the player still sees the retry toast.
            //
            // Exactly ONE notify fires per empty turn (state XOR turn-error) — no
            // refresh storm (T-10-10). notifySession is already imported above
            // (it is the call we are branching, not duplicating).
            const combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan;
            console.warn('turn produced empty response (vault path)', { sessionId, combatStateChanged, openerRan });
            if (combatStateChanged) {
              // A real server-resolved combat turn that legitimately advanced state.
              // Emit a silent refresh so the tracker updates; do NOT emit turn-error
              // (that would show a bogus "no response / retry" toast — T-10-14).
              notifySession(sessionId, { type: 'state' }).catch(
                (e) => console.warn('notifySession(state) failed:', e instanceof Error ? e.message : String(e)),
              );
            } else {
              // Genuine non-combat empty: the model produced nothing and no server
              // logic changed state. Surface the retry toast so the player can re-prompt.
              notifySession(sessionId, {
                type: 'turn-error',
                reason: 'empty_response',
                message: 'Il Master non ha prodotto una risposta. Riprova o riformula.',
              }).catch((e) => console.warn('notifySession(turn-error) failed:', e instanceof Error ? e.message : String(e)));
            }
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
