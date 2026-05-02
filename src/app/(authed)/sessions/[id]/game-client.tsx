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
import { useTurnStream } from '@/sessions/use-turn-stream';
import { useSessionState } from '@/sessions/use-session-state';
import { AutoplayToggle } from '@/components/game/autoplay-toggle';
import { SettingsLink } from '@/components/ui/settings-link';
import { setActiveAudio, getActiveAudio } from '@/lib/tts-playback';
import type { Character } from '@/engine/types';
import type { CombatActorRow, DiceRollRow, MessageRow, SessionRow, SessionStateRow } from '@/sessions/client-types';

export interface GameClientProps {
  sessionId: string;
  session: SessionRow;
  character: Character;
  initialState: SessionStateRow | null;
  initialMessages: MessageRow[];
  initialRolls: DiceRollRow[];
  initialActors: CombatActorRow[];
  initialAutoplay: boolean;
}

export function GameClient({ sessionId, session, character, initialState, initialMessages, initialRolls, initialActors, initialAutoplay }: GameClientProps) {
  const [messages, setMessages] = React.useState<MessageRow[]>(initialMessages);
  const [rolls, setRolls] = React.useState<DiceRollRow[]>(initialRolls);
  const [spellOpen, setSpellOpen] = React.useState(false);
  const [autoplay, setAutoplay] = React.useState(initialAutoplay);
  const lastCompleteIdRef = React.useRef<string | null>(null);
  // Seed with the most recent persisted master message so we don't autoplay it on page mount.
  const lastAutoplayedRef = React.useRef<string | null>(
    [...initialMessages].reverse().find((m) => m.role === 'master')?.id ?? null,
  );
  const turn = useTurnStream(sessionId);
  const stateSub = useSessionState(sessionId);

  const liveState: SessionStateRow | null = stateSub.snapshot?.state ?? initialState;
  const liveActors: CombatActorRow[] = stateSub.snapshot?.actors ?? initialActors;

  // Derive server-side error from any turn_error event in the stream.
  const serverError = React.useMemo(() => {
    const ev = turn.events.find((e) => e.type === 'turn_error');
    return ev && ev.type === 'turn_error' ? ev.reason : null;
  }, [turn.events]);

  // When a turn completes, refresh messages + dice log. Guard with a ref so the
  // effect only fires once per turn_complete (avoids races if events array mutates).
  React.useEffect(() => {
    const last = turn.events.at(-1);
    if (last?.type === 'turn_complete' && !turn.busy && lastCompleteIdRef.current !== last.messageId) {
      lastCompleteIdRef.current = last.messageId;
      void Promise.all([
        fetch(`/api/sessions/${sessionId}/messages`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/sessions/${sessionId}/dice-log`).then((r) => (r.ok ? r.json() : null)),
      ]).then((results) => {
        const msgs = results[0] as { messages: MessageRow[] } | null;
        const rs = results[1] as { rolls: DiceRollRow[] } | null;
        if (msgs) setMessages(msgs.messages);
        if (rs) setRolls(rs.rolls);
        turn.reset();
      });
    }
  }, [turn, sessionId]);

  const send = (text: string): void => {
    setMessages((prev) => [...prev, { id: `temp-${Date.now()}`, sessionId, role: 'player', content: text, createdAt: new Date().toISOString() }]);
    void turn.send(text);
  };

  // Auto-play the latest persisted master message when the toggle is on.
  React.useEffect(() => {
    if (!autoplay) return;
    const newest = [...messages]
      .reverse()
      .find((m) => m.role === 'master' && !m.id.startsWith('temp-'));
    if (!newest) return;
    if (lastAutoplayedRef.current === newest.id) return;
    lastAutoplayedRef.current = newest.id;

    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/messages/${newest.id}/tts`);
        if (!res.ok) return; // silent — UI can still play manually via the Listen button
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          if (getActiveAudio() === audio) setActiveAudio(null);
          URL.revokeObjectURL(url);
        };
        setActiveAudio(audio);
        await audio.play();
      } catch {
        // Network / decode error — keep the manual Listen button as a fallback.
      }
    })();
  }, [messages, autoplay, sessionId]);

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
            {liveState.inCombat ? 'COMBAT' : 'EXPLORATION'} · LANG {session.language?.toUpperCase() ?? '–'}
          </div>
        </div>
        <AutoplayToggle value={autoplay} onChange={setAutoplay} />
        <SettingsLink variant="ghost" size="sm" iconOnly />
        <Chip tone="accent" dot>SSE live</Chip>
        <Wordmark size={14} style={{ opacity: 0.7 }} />
      </header>

      <div style={{ display: 'flex', flex: 1, alignItems: 'stretch' }}>
        <CharacterPane character={character} state={liveState} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
          <NarrativePane
            sessionId={sessionId}
            history={messages}
            liveEvents={turn.events}
            busy={turn.busy}
            onSend={send}
            onCastSpell={character.spellcasting && slots.length > 0 ? () => setSpellOpen(true) : undefined}
          />
          {(turn.error || serverError) && (
            <div style={{ padding: '8px 16px', background: 'var(--bg-card)', color: 'var(--ember)', borderTop: '1px solid var(--ember)', fontSize: 12 }}>
              <Icon name="x" size={12} /> {turn.error ?? serverError}
            </div>
          )}
          {spellOpen && character.spellcasting && (
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
          state={liveState}
          actors={liveActors}
          diceLog={rolls}
          pcCharacterId={character.id}
          pcName={character.name}
          pcHpMax={character.hpMax}
        />
      </div>
    </div>
  );
}
