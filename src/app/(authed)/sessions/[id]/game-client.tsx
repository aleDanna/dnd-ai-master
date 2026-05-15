'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Icon } from '@/components/ui/icon';
import { Wordmark } from '@/components/ui/wordmark';
import { CharacterPane } from '@/components/game/character-pane';
import { NarrativePane } from '@/components/game/narrative-pane';
import { MechanicsPane } from '@/components/game/mechanics-pane';
import { SpellModal } from '@/components/game/spell-modal';
import { PartyStrip } from '@/components/sessions/party-strip';
import { useSessionStream } from '@/sessions/use-session-stream';
import { AutoplayToggle } from '@/components/game/autoplay-toggle';
import { MemoryStatusBanner } from '@/components/memory-status-banner';
import { setActiveAudio, getActiveAudio, setLoadingMessageId } from '@/lib/tts-playback';
import type { Character } from '@/engine/types';
import type { CampaignRow, CombatActorRow, MessageRow, SessionRow, SessionStateRow } from '@/sessions/client-types';
import type { MasterInventoryView } from '@/srd/enrich-inventory';
import { useIsMobile } from '@/lib/use-is-mobile';
import { TopBarMobile } from '@/components/layout/top-bar-mobile';
import { Drawer } from '@/components/ui/drawer';
import { MobileCharacterBar } from '@/components/game/mobile-character-bar';
import { MobileMechanicsFab } from '@/components/game/mobile-mechanics-fab';

export interface GameClientProps {
  sessionId: string;
  session: SessionRow;
  campaign: CampaignRow | null;
  character: Character;
  initialState: SessionStateRow | null;
  initialMessages: MessageRow[];
  initialActors: CombatActorRow[];
  initialAutoplay: boolean;
  initialManualRolls: boolean;
  initialImageGenerationEnabled: boolean;
}

export function GameClient({ sessionId, session, campaign, character: initialCharacter, initialState, initialMessages, initialActors, initialAutoplay, initialManualRolls, initialImageGenerationEnabled }: GameClientProps) {
  const [memoryReady, setMemoryReady] = React.useState(false);
  const [messages, setMessages] = React.useState<MessageRow[]>(initialMessages);
  // Character mirror: starts from SSR-provided value, refreshed on mount and
  // after every message final event. Mutable character fields (level, xp, hpMax,
  // ...) stay in sync with the server even when the player navigates away
  // and back to the session.
  const [character, setCharacter] = React.useState<Character>(initialCharacter);
  const [enrichedInventory, setEnrichedInventory] = React.useState<MasterInventoryView[]>([]);
  const [spellOpen, setSpellOpen] = React.useState(false);
  const [autoplay, setAutoplay] = React.useState(initialAutoplay);
  const isMobile = useIsMobile();
  const [charDrawerOpen, setCharDrawerOpen] = React.useState(false);
  const [mechDrawerOpen, setMechDrawerOpen] = React.useState(false);
  // sending tracks the in-flight POST to /turn (before the SSE stream takes over)
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const lastAutoplayedRef = React.useRef<string | null>(
    [...initialMessages].reverse().find((m) => m.role === 'master')?.id ?? null,
  );

  const {
    snapshot,
    streamingMessage,
    error: streamError,
    turnError,
    clearTurnError,
    finalizedSeq,
    clearStreamingMessage,
    ttsPending,
    ttsErrors,
    imagePending,
    imageError,
  } = useSessionStream(sessionId);

  // Derive live state: prefer snapshot from SSE, fall back to SSR props
  const liveState: SessionStateRow | null = (snapshot?.state as SessionStateRow | null) ?? initialState;
  const liveActors: CombatActorRow[] = (snapshot as any)?.actors ?? initialActors;

  // Build a synthesized liveEvents array from streamingMessage for NarrativePane.
  // NarrativePane consumes TurnEvent[] and derives the live text from
  // narrative_delta entries; we map the streamed text into that shape.
  const liveEvents = React.useMemo<import('@/sessions/types').TurnEvent[]>(() => {
    if (!streamingMessage?.text) return [];
    return [{ type: 'narrative_delta', text: streamingMessage.text }];
  }, [streamingMessage]);

  // "Master is responding…" indicator. Stays on for the WHOLE window between
  // kicking off a turn (POST 202 returns in ~100ms; `sending` is true only
  // during that window) and the master starting to stream — historically a
  // multi-second gap where the spinner used to vanish. `pendingTurn` below
  // closes that gap.
  const [pendingTurn, setPendingTurn] = React.useState(false);
  const busy = streamingMessage !== null || sending || pendingTurn;

  // Live character mutable fields from the SSE snapshot. Merging
  // onto the local React state on every snapshot tick makes the right-pane
  // UI (XP bar, AC, inventory, spell slots) eventually consistent with the DB.
  React.useEffect(() => {
    const patch = snapshot?.character;
    if (!patch) return;
    setCharacter((prev) => {
      if (
        prev.id === patch.id &&
        prev.level === patch.level &&
        prev.xp === patch.xp &&
        prev.hpMax === patch.hpMax &&
        prev.ac === patch.ac &&
        prev.proficiencyBonus === patch.proficiencyBonus &&
        prev.inventory === patch.inventory &&
        prev.spellcasting === patch.spellcasting &&
        prev.features === patch.features &&
        prev.inspiration === patch.inspiration &&
        prev.attunedItems === patch.attunedItems &&
        prev.equippedFocus === patch.equippedFocus &&
        prev.classes === patch.classes &&
        prev.senses === patch.senses
      ) return prev;
      return {
        ...prev,
        level: patch.level,
        xp: patch.xp,
        hpMax: patch.hpMax,
        ac: patch.ac,
        proficiencyBonus: patch.proficiencyBonus,
        inventory: patch.inventory,
        spellcasting: patch.spellcasting as Character['spellcasting'],
        features: patch.features as Character['features'],
        inspiration: patch.inspiration ?? prev.inspiration,
        attunedItems: patch.attunedItems ?? prev.attunedItems,
        equippedFocus: patch.equippedFocus ?? prev.equippedFocus,
        classes: patch.classes ?? prev.classes,
        senses: patch.senses ?? prev.senses,
      };
    });
    const next = (patch as { enrichedInventory?: MasterInventoryView[] }).enrichedInventory;
    if (next) setEnrichedInventory(next);
  }, [snapshot?.character]);

  // Pure fetch — returns fresh messages + character. Side-effect-free so it
  // can be called from effects without triggering lint warnings.
  const fetchSessionData = React.useCallback(async (): Promise<{
    messages: MessageRow[] | null;
    character: Character | null;
  }> => {
    const [msgsRes, charRes] = await Promise.all([
      fetch(`/api/sessions/${sessionId}/messages`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/sessions/${sessionId}/character`).then((r) => (r.ok ? r.json() : null)),
    ]);
    return {
      messages: (msgsRes as { messages: MessageRow[] } | null)?.messages ?? null,
      character: (charRes as { character: Character } | null)?.character ?? null,
    };
  }, [sessionId]);

  // On mount: pull fresh server state. Fixes stale SSR'd messages when
  // client-navigating back to the session page.
  React.useEffect(() => {
    let active = true;
    void fetchSessionData().then((data) => {
      if (!active) return;
      if (data.messages) setMessages(data.messages);
      if (data.character) setCharacter(data.character);
    });
    return () => { active = false; };
  }, [fetchSessionData]);

  // When streamingMessage transitions from non-null → null, the master
  // message has been finalised. Refetch to get authoritative content.
  const prevStreamingRef = React.useRef<boolean>(false);
  React.useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    const isStreaming = streamingMessage !== null;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming) {
      // SSE delivered the full turn — kill the safety poll started by `send`.
      if (safetyPollRef.current) {
        clearInterval(safetyPollRef.current);
        safetyPollRef.current = null;
      }
      // Stream just ended — refresh messages
      let active = true;
      void fetchSessionData().then((data) => {
        if (!active) return;
        if (data.messages) setMessages(data.messages);
        if (data.character) setCharacter(data.character);
      });
      return () => { active = false; };
    }
  }, [streamingMessage, fetchSessionData]);

  // Refetch messages whenever the stream signals a turn finalization. The
  // stream-ended effect above only fires when `streamingMessage` actually
  // transitions from non-null to null — which never happens if the
  // `message-chunk` events drop in transit and only the final `message`
  // event arrives. Without this, the master's reply was persisted server-
  // side but the client kept showing the pre-turn message list until the
  // user reloaded the page.
  const prevFinalizedRef = React.useRef(0);
  React.useEffect(() => {
    if (finalizedSeq === 0 || finalizedSeq === prevFinalizedRef.current) return;
    prevFinalizedRef.current = finalizedSeq;
    if (safetyPollRef.current) {
      clearInterval(safetyPollRef.current);
      safetyPollRef.current = null;
    }
    let active = true;
    void fetchSessionData().then((data) => {
      if (!active) return;
      if (data.messages) setMessages(data.messages);
      if (data.character) setCharacter(data.character);
    });
    return () => { active = false; };
  }, [finalizedSeq, fetchSessionData]);

  // POST to /turn. Returns true on success, false on error.
  const postTurn = React.useCallback(async (payload: { message?: string; begin?: boolean }): Promise<boolean> => {
    if (sending) return false;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const errMsg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
        // 409 already-begun is expected on remount — treat as no-op
        if (res.status === 409) return true;
        setSendError(errMsg);
        return false;
      }
      return true;
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'unknown');
      return false;
    } finally {
      setSending(false);
    }
  }, [sending, sessionId]);

  // Post-turn safety refetch — if SSE never delivers the master's response
  // (Supavisor session pool dropping NOTIFY, function timeout, dropped socket, …), the
  // UI used to hang forever on the player's "temp-…" bubble. We poll the
  // messages endpoint every 3s after a send and stop as soon as a new master
  // message lands, or after a hard ceiling (90s).
  const safetyPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const clearSafetyPoll = React.useCallback(() => {
    if (safetyPollRef.current) {
      clearInterval(safetyPollRef.current);
      safetyPollRef.current = null;
    }
  }, []);
  const startSafetyPoll = React.useCallback(() => {
    clearSafetyPoll();
    const baselineMasterCount = messages.filter((m) => m.role === 'master').length;
    const startedAt = Date.now();
    safetyPollRef.current = setInterval(() => {
      void fetchSessionData().then((data) => {
        if (!data.messages) return;
        const masterCount = data.messages.filter((m) => m.role === 'master').length;
        if (masterCount > baselineMasterCount) {
          setMessages(data.messages);
          if (data.character) setCharacter(data.character);
          // If chunks had arrived but the final `message` event got dropped,
          // streamingMessage would still be non-null, keeping busy=true and
          // the composer locked. Clearing it here releases that gate now
          // that the persisted message is on screen.
          clearStreamingMessage();
          clearSafetyPoll();
          return;
        }
        // Hard timeout — stop polling so we don't hammer the API forever on a
        // truly broken turn (master errored out without persisting anything).
        if (Date.now() - startedAt > 90_000) clearSafetyPoll();
      }).catch(() => { /* network blip — keep polling */ });
    }, 3000);
  }, [messages, fetchSessionData, clearSafetyPoll, clearStreamingMessage]);

  React.useEffect(() => () => clearSafetyPoll(), [clearSafetyPoll]);

  // Auto-open the campaign: kick off the synthetic "begin" turn when the
  // session has no messages yet and memory is ready.
  const beganRef = React.useRef(false);
  React.useEffect(() => {
    if (beganRef.current) return;
    if (!memoryReady) return;
    if (busy) return;
    if (messages.length > 0) return;
    beganRef.current = true;
    // Light up the "Master is responding…" indicator immediately — the
    // master can take a few seconds to produce the opening scene.
    setPendingTurn(true);
    void postTurn({ begin: true });
    // Mirror the regular `send()` path: arm the safety poll so a dropped
    // SSE on the opening turn still lets the master's intro show up
    // without a page refresh.
    startSafetyPoll();
  }, [memoryReady, busy, messages.length, postTurn, startSafetyPoll]);

  // `pendingTurn` covers the window between kicking off a turn (POST /turn
  // returning 202) and the master starting to stream the response. It powers
  // both the "Master is responding…" indicator (via `busy`) and the composer
  // lock (so the player can't double-submit during that gap). Cleared by the
  // first streamed chunk, by a turn-error, or by a 12s safety ceiling.
  React.useEffect(() => {
    if (!pendingTurn) return;
    if (streamingMessage || turnError) {
      setPendingTurn(false);
      return;
    }
    const t = setTimeout(() => setPendingTurn(false), 12_000);
    return () => clearTimeout(t);
  }, [pendingTurn, streamingMessage, turnError]);

  const send = (text: string): void => {
    setMessages((prev) => [
      ...prev,
      { id: `temp-${Date.now()}`, sessionId, role: 'player', content: text, createdAt: new Date().toISOString() },
    ]);
    setPendingTurn(true);
    void postTurn({ message: text });
    startSafetyPoll();
  };

  const handleMemoryReady = React.useCallback(() => {
    setMemoryReady(true);
  }, []);

  const endCombat = React.useCallback((): void => {
    void fetch(`/api/sessions/${sessionId}/end-combat`, { method: 'POST' });
  }, [sessionId]);

  // Multiplayer: composer gating
  const party: Array<{ id: string; name: string; raceSlug: string; classSlug: string; level: number }> =
    (snapshot?.party ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      raceSlug: p.raceSlug,
      classSlug: p.classSlug,
      level: p.level,
    }));
  const currentPlayerCharacterId: string | null = snapshot?.currentPlayerCharacterId ?? null;
  const viewerCharacterId: string | null = snapshot?.viewerCharacterId ?? null;
  // Multiplayer rule: if the snapshot has *any* turn ownership signal
  // (`currentPlayerCharacterId` set), the viewer MUST match it to act. Falling
  // back to `true` whenever `viewerCharacterId` was null used to let players
  // keep typing after their turn ended — every refetch / SSE message blanked
  // `viewerCharacterId` to null, and the composer popped open again.
  // Legacy single-character sessions have `currentPlayerCharacterId === null`,
  // so we keep them permissive in that branch. Solo campaigns (party of 0–1)
  // also skip the gate: there's no other player to share the turn with, so
  // any cpcId/viewerCharacterId mismatch (snapshot lag, legacy migrations)
  // must NOT lock the only player out of their own game.
  const isMyTurn =
    party.length <= 1
      ? true
      : currentPlayerCharacterId === null
        ? true
        : viewerCharacterId !== null && viewerCharacterId === currentPlayerCharacterId;
  const currentPlayerName = party.find((p) => p.id === currentPlayerCharacterId)?.name ?? '...';

  // Derive the latest persisted master message id for TTS autoplay.
  const latestMasterMsgId = React.useMemo<string | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'master' && !m.id.startsWith('temp-')) return m.id;
    }
    return null;
  }, [messages]);

  const inFlightTtsRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!autoplay) return;
    if (!latestMasterMsgId) return;
    if (lastAutoplayedRef.current === latestMasterMsgId) return;
    if (inFlightTtsRef.current === latestMasterMsgId) return;
    const target = latestMasterMsgId;
    inFlightTtsRef.current = target;
    setLoadingMessageId(target);

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/messages/${target}/tts`);
        if (cancelled || !res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          if (getActiveAudio() === audio) setActiveAudio(null);
          URL.revokeObjectURL(url);
        };
        setActiveAudio(audio, target);
        await audio.play();
        if (!cancelled) lastAutoplayedRef.current = target;
      } catch (e) {
        console.warn('tts.autoplay.failed', e instanceof Error ? e.message : e);
      } finally {
        if (inFlightTtsRef.current === target) inFlightTtsRef.current = null;
        setLoadingMessageId(null);
      }
    })();

    return () => { cancelled = true; };
  }, [latestMasterMsgId, autoplay, sessionId]);

  if (!liveState) {
    return (
      <main style={{ padding: 40, color: 'var(--fg-muted)' }}>Loading session…</main>
    );
  }

  const slots = character.spellcasting
    ? Object.entries(character.spellcasting.slotsMax).map(([level, max]) => ({
        level: Number(level),
        max,
        used: liveState.spellSlotsUsed[level] ?? 0,
      }))
    : [];

  // Composer is locked when: memory isn't ready, it's not the viewer's turn,
  // or the master is currently busy (POST in flight, streaming, OR we just
  // submitted and the master hasn't started streaming yet — `pendingTurn`).
  const composerDisabled = !memoryReady || !isMyTurn || busy;

  if (isMobile) {
    const inCombat = liveState.inCombat;
    const round = (liveState.combat?.round as number | undefined) ?? undefined;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
        <TopBarMobile
          leading={
            <Link href="/sessions">
              <Button variant="ghost" size="sm" icon="arrow-left" aria-label="Back to sessions" />
            </Link>
          }
          title={campaign?.name ?? `${character.name}'s session`}
          subtitle={`${inCombat ? 'COMBAT' : 'EXPLORATION'} · ${(campaign?.language ?? session.language)?.toUpperCase() ?? '—'} · ${party.length > 1 ? `${party.length}P` : 'SOLO'}`}
          trailing={
            <>
              <AutoplayToggle value={autoplay} onChange={setAutoplay} />
            </>
          }
        />
        <MobileCharacterBar character={character} state={liveState} onOpen={() => setCharDrawerOpen(true)} />
        {snapshot && party.length > 1 && (
          <div style={{ padding: '6px 12px', background: 'var(--bg)', position: 'sticky', top: 100, zIndex: 18, flexShrink: 0 }}>
            <PartyStrip
              party={party}
              currentPlayerCharacterId={currentPlayerCharacterId}
              viewerCharacterId={viewerCharacterId}
            />
          </div>
        )}
        {!memoryReady && (
          <div style={{ padding: '8px 16px', flexShrink: 0 }}>
            <MemoryStatusBanner sessionId={sessionId} onReady={handleMemoryReady} />
          </div>
        )}
        <NarrativePane
          sessionId={sessionId}
          history={messages}
          liveEvents={liveEvents}
          busy={busy}
          onSend={send}
          onCastSpell={!composerDisabled && character.spellcasting && slots.length > 0 ? () => setSpellOpen(true) : undefined}
          manualRolls={initialManualRolls}
          imageGenerationEnabled={initialImageGenerationEnabled}
          disabled={composerDisabled}
          disabledPlaceholder={!memoryReady ? 'Preparazione memoria in corso…' : `Waiting for ${currentPlayerName}…`}
          party={party}
          compact
          ttsPending={ttsPending}
          ttsErrors={ttsErrors}
          imagePending={imagePending}
          imageError={imageError}
        />
        <MobileMechanicsFab
          gameMode={inCombat ? 'combat' : 'exploration'}
          round={round}
          onOpen={() => setMechDrawerOpen(true)}
        />
        <Drawer open={charDrawerOpen} onOpenChange={setCharDrawerOpen}>
          <CharacterPane character={character} state={liveState} enrichedInventory={enrichedInventory} compact />
        </Drawer>
        <Drawer open={mechDrawerOpen} onOpenChange={setMechDrawerOpen}>
          <MechanicsPane
            sessionId={sessionId}
            state={liveState}
            actors={liveActors}
            pcCharacterId={character.id}
            pcLevel={character.level}
            pcXp={character.xp}
            onEndCombat={endCombat}
            pcName={character.name}
            pcHpMax={character.hpMax}
            pcSpeed={character.speed}
            compact
          />
        </Drawer>
        {(sendError || streamError || turnError) && (
          <div style={{ padding: '8px 16px', background: 'var(--bg-card)', color: 'var(--ember)', borderTop: '1px solid var(--ember)', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="x" size={12} />
              {sendError ?? streamError ?? turnError?.message ?? 'Errore turno.'}
            </span>
            {turnError && (
              <button type="button" onClick={clearTurnError} style={{ background: 'transparent', border: '1px solid var(--ember)', color: 'var(--ember)', padding: '2px 8px', borderRadius: 999, fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>
                Chiudi
              </button>
            )}
          </div>
        )}
        {spellOpen && character.spellcasting && !composerDisabled && (
          <SpellModal
            spellsKnown={character.spellcasting.spellsKnown}
            slots={slots}
            onCast={(spellSlug, slotLevel) => {
              send(`I cast ${spellSlug} at level ${slotLevel}.`);
              setSpellOpen(false);
            }}
            onClose={() => setSpellOpen(false)}
          />
        )}
      </div>
    );
  }

  // Desktop branch — unchanged
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 24px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Link href="/sessions"><Button variant="ghost" size="sm" icon="arrow-left">Sessions</Button></Link>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 17 }}>{character.name}&apos;s session</div>
          <div style={{ fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
            {liveState.inCombat ? 'COMBAT' : 'EXPLORATION'} · LANG {(campaign?.language ?? session.language)?.toUpperCase() ?? '–'}
          </div>
        </div>
        <AutoplayToggle value={autoplay} onChange={setAutoplay} />
        <Chip tone="accent" dot>SSE live</Chip>
        <Wordmark size={14} style={{ opacity: 0.7 }} />
      </header>

      <div style={{ display: 'flex', flex: 1, alignItems: 'stretch' }}>
        <CharacterPane character={character} state={liveState} enrichedInventory={enrichedInventory} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
          {!memoryReady && (
            <div style={{ padding: '8px 16px', flexShrink: 0 }}>
              <MemoryStatusBanner sessionId={sessionId} onReady={handleMemoryReady} />
            </div>
          )}
          {snapshot && party.length > 1 && (
            // Sticky right under the 56px top header so the party roster +
            // active-turn indicator stay visible while the narrative scrolls.
            // `zIndex: 5` keeps it above the narrative bubbles but below the
            // header's z-index: 10. We give the wrapper a solid page bg so
            // the horizontal padding doesn't "see-through" scrolling content.
            <div
              style={{
                padding: '8px 40px 0',
                background: 'var(--bg)',
                position: 'sticky',
                top: 56,
                zIndex: 5,
                flexShrink: 0,
              }}
            >
              <PartyStrip
                party={party}
                currentPlayerCharacterId={currentPlayerCharacterId}
                viewerCharacterId={viewerCharacterId}
              />
            </div>
          )}
          <NarrativePane
            sessionId={sessionId}
            history={messages}
            liveEvents={liveEvents}
            busy={busy}
            onSend={send}
            // Drop the spell-cast affordance when the composer is locked: an
            // open Spell modal would still call `send()` directly (bypassing
            // the textarea/Send gates), so we close that path at the source
            // rather than half-disabling the UI.
            onCastSpell={!composerDisabled && character.spellcasting && slots.length > 0 ? () => setSpellOpen(true) : undefined}
            manualRolls={initialManualRolls}
            imageGenerationEnabled={initialImageGenerationEnabled}
            disabled={composerDisabled}
            disabledPlaceholder={
              !memoryReady
                ? 'Preparazione memoria in corso…'
                : busy
                  ? 'The Master is responding…'
                  : `Waiting for ${currentPlayerName}…`
            }
            party={party}
            ttsPending={ttsPending}
            ttsErrors={ttsErrors}
            imagePending={imagePending}
            imageError={imageError}
          />
          {(sendError || streamError || turnError) && (
            <div
              style={{
                padding: '8px 16px',
                background: 'var(--bg-card)',
                color: 'var(--ember)',
                borderTop: '1px solid var(--ember)',
                fontSize: 12,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="x" size={12} />
                {sendError ?? streamError ?? turnError?.message ?? 'Errore turno.'}
              </span>
              {turnError && (
                <button
                  type="button"
                  onClick={clearTurnError}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--ember)',
                    color: 'var(--ember)',
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Chiudi
                </button>
              )}
            </div>
          )}
          {spellOpen && character.spellcasting && !composerDisabled && (
            <SpellModal
              spellsKnown={character.spellcasting.spellsKnown}
              slots={slots}
              onCast={(spellSlug, slotLevel) => {
                send(`I cast ${spellSlug} at level ${slotLevel}.`);
                setSpellOpen(false);
              }}
              onClose={() => setSpellOpen(false)}
            />
          )}
        </div>
        <MechanicsPane
          sessionId={sessionId}
          state={liveState}
          actors={liveActors}
          pcCharacterId={character.id}
          pcLevel={character.level}
          pcXp={character.xp}
          onEndCombat={endCombat}
          pcName={character.name}
          pcHpMax={character.hpMax}
          pcSpeed={character.speed}
        />
      </div>
    </div>
  );
}
