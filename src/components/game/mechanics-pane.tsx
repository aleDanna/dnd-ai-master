'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { CombatTracker } from './combat-tracker';
import { DiceLogPanel } from './dice-log-panel';
import type { CombatActorRow, DiceRollRow, SessionStateRow } from '@/sessions/client-types';

export interface MechanicsPaneProps {
  state: SessionStateRow;
  actors: CombatActorRow[];
  diceLog: DiceRollRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpMax: number;
}

export function MechanicsPane({ state, actors, diceLog, pcCharacterId, pcName, pcHpMax }: MechanicsPaneProps) {
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
      <CombatTracker
        state={state}
        actors={actors}
        pcCharacterId={pcCharacterId}
        pcName={pcName}
        pcHpCurrent={state.hpCurrent}
        pcHpMax={pcHpMax}
      />
      <DiceLogPanel rolls={diceLog} />
      <section>
        <Eyebrow style={{ marginBottom: 6 }}>Scene</Eyebrow>
        <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
          {state.scene || 'No scene set yet.'}
        </div>
      </section>
    </aside>
  );
}
