'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import { CombatTracker } from './combat-tracker';
import { XpBar } from './xp-bar';
import { RebuildMemoryButton } from '@/components/rebuild-memory-button';
import type { CombatActorRow, SessionStateRow } from '@/sessions/client-types';

export interface MechanicsPaneProps {
  sessionId: string;
  state: SessionStateRow;
  actors: CombatActorRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpMax: number;
  pcLevel: number;
  pcXp: number;
  /** PC speed in ft. Used by the combat tracker for the movement budget display. */
  pcSpeed?: number;
  /** Forwarded to CombatTracker for the manual "End combat" escape hatch. */
  onEndCombat?: () => void;
  /** When true the pane drops desktop sidebar chrome and renders as drawer content. */
  compact?: boolean;
}

const PACE_LABEL: Record<'fast' | 'normal' | 'slow', string> = {
  fast: 'Fast (4 mi/h, -5 PP)',
  normal: 'Normal (3 mi/h)',
  slow: 'Slow (2 mi/h, stealth)',
};

const LIGHT_LABEL: Record<'bright' | 'dim' | 'darkness', string> = {
  bright: 'Bright',
  dim: 'Dim',
  darkness: 'Darkness',
};

export function MechanicsPane({ sessionId, state, actors, pcCharacterId, pcName, pcHpMax, pcLevel, pcXp, pcSpeed, onEndCombat, compact = false }: MechanicsPaneProps) {
  const travel = state.travel;
  const showTravel = travel != null && (travel.pace || travel.lightLevel);
  return (
    <aside
      style={{
        width: compact ? '100%' : 320,
        padding: 18,
        borderLeft: compact ? '' : '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        flexShrink: 0,
        // Span the viewport vertically (minus the 56px sticky topbar) instead
        // of collapsing to content. Internal overflow scrolls; the chrome
        // always reaches the bottom edge.
        ...(compact ? {} : { position: 'sticky', top: 56, height: 'calc(100vh - 56px)', overflowY: 'auto' }),
      }}
    >
      {/* Memoria sits at the top so the player can trigger a codex rebuild
          without scrolling past HP / scene / inventory. Useful after a crash
          mid-turn left the extractor behind. */}
      <section>
        <Eyebrow style={{ marginBottom: 6 }}>Memoria</Eyebrow>
        <RebuildMemoryButton sessionId={sessionId} />
      </section>
      <XpBar level={pcLevel} xp={pcXp} />
      {showTravel && (
        <section>
          <Eyebrow style={{ marginBottom: 6 }}>Travel</Eyebrow>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {travel.pace && <Chip tone="neutral">Pace: {PACE_LABEL[travel.pace]}</Chip>}
            {travel.lightLevel && (
              <Chip tone={travel.lightLevel === 'darkness' ? 'ember' : travel.lightLevel === 'dim' ? 'warn' : 'gold'}>
                Light: {LIGHT_LABEL[travel.lightLevel]}
              </Chip>
            )}
          </div>
        </section>
      )}
      <CombatTracker
        state={state}
        actors={actors}
        pcCharacterId={pcCharacterId}
        pcName={pcName}
        pcHpCurrent={state.hpCurrent}
        pcHpMax={pcHpMax}
        pcSpeed={pcSpeed}
        pcTurnState={state.turnState}
        pcPosition={state.position}
        pcConditions={state.conditions}
        onEndCombat={onEndCombat}
      />
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
