'use client';
import { Icon } from '@/components/ui/icon';

export type GameMode = 'combat' | 'exploration';

export interface MobileMechanicsFabProps {
  gameMode: GameMode;
  round?: number;
  onOpen: () => void;
}

export function MobileMechanicsFab({ gameMode, round, onOpen }: MobileMechanicsFabProps) {
  const inCombat = gameMode === 'combat';
  const showBadge = inCombat && typeof round === 'number' && round > 0;
  return (
    <button
      type="button"
      aria-label="Mechanics"
      onClick={onOpen}
      style={{
        position: 'fixed',
        bottom: 86,
        right: 14,
        zIndex: 6,
        width: 48,
        height: 48,
        borderRadius: '50%',
        background: inCombat ? 'var(--ember)' : 'var(--bg-card)',
        border: '1px solid ' + (inCombat ? 'var(--ember-2)' : 'var(--border-strong)'),
        color: inCombat ? '#fff' : 'var(--fg-muted)',
        boxShadow: 'var(--shadow-3)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={inCombat ? 'sword' : 'compass'} size={20} />
      {showBadge ? (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            background: 'var(--gold)',
            color: 'var(--ink)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 999,
            border: '2px solid var(--bg)',
          }}
        >
          R{round}
        </span>
      ) : null}
    </button>
  );
}
