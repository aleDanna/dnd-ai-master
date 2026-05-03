'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { CombatTracker } from './combat-tracker';
import { DiceLogPanel } from './dice-log-panel';
import { XpBar } from './xp-bar';
import type { CombatActorRow, DiceRollRow, SessionStateRow } from '@/sessions/client-types';

export interface MechanicsPaneProps {
  sessionId: string;
  state: SessionStateRow;
  actors: CombatActorRow[];
  diceLog: DiceRollRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpMax: number;
  pcLevel: number;
  pcXp: number;
  /** Forwarded to CombatTracker for the manual "End combat" escape hatch. */
  onEndCombat?: () => void;
}

export function MechanicsPane({ sessionId, state, actors, diceLog, pcCharacterId, pcName, pcHpMax, pcLevel, pcXp, onEndCombat }: MechanicsPaneProps) {
  return (
    <aside
      style={{
        width: 320,
        padding: 18,
        borderLeft: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        flexShrink: 0,
        alignSelf: 'flex-start',
        position: 'sticky',
        top: 56,
        maxHeight: 'calc(100vh - 56px)',
        overflowY: 'auto',
      }}
    >
      <XpBar level={pcLevel} xp={pcXp} />
      <CombatTracker
        state={state}
        actors={actors}
        pcCharacterId={pcCharacterId}
        pcName={pcName}
        pcHpCurrent={state.hpCurrent}
        pcHpMax={pcHpMax}
        onEndCombat={onEndCombat}
      />
      <DiceLogPanel rolls={diceLog} />
      <section>
        <Eyebrow style={{ marginBottom: 6 }}>Scene</Eyebrow>
        {state.sceneImageVersion > 0 && (
          <img
            src={`/api/sessions/${sessionId}/scene-image?v=${state.sceneImageVersion}`}
            // The visual prompt is always English (gpt-image-1 prefers it),
            // but the player's narrative language may not be. Use a generic
            // alt instead of leaking the English prompt to assistive tech.
            alt="Scene illustration"
            style={{
              width: '100%',
              aspectRatio: '1 / 1',
              objectFit: 'cover',
              borderRadius: 8,
              border: '1px solid var(--border)',
              marginBottom: 8,
              display: 'block',
            }}
          />
        )}
        <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
          {state.scene || 'No scene set yet.'}
        </div>
      </section>
    </aside>
  );
}
