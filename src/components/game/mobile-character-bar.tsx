'use client';
import { Icon } from '@/components/ui/icon';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

export interface MobileCharacterBarProps {
  character: Character;
  state: SessionStateRow;
  onOpen: () => void;
}

export function MobileCharacterBar({ character, state, onOpen }: MobileCharacterBarProps) {
  const hpPct = character.hpMax > 0 ? Math.round((state.hpCurrent / character.hpMax) * 100) : 0;
  const hpTone = hpPct <= 25 ? 'var(--ember)' : hpPct <= 50 ? 'var(--gold)' : 'var(--verdigris)';
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: 'var(--bg-elev)',
        borderBottom: '1px solid var(--border)',
        border: 0,
        borderRadius: 0,
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        fontFamily: 'inherit',
        flexShrink: 0,
        position: 'sticky',
        top: 44,
        zIndex: 19,
        width: '100%',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 6,
          background: 'var(--bone)',
          color: 'var(--ink)',
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {character.name[0]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{character.name}</span>
          {character.inspiration ? (
            <Icon name="star" size={12} aria-label="Inspiration" style={{ color: 'var(--gold)' }} />
          ) : null}
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
            L{character.level} · AC {character.ac}
          </span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>
            {state.hpCurrent}/{character.hpMax} HP
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-sunken)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, hpPct))}%`, background: hpTone }} />
        </div>
      </div>
      <Icon name="chevron-up" size={14} style={{ color: 'var(--fg-subtle)' }} />
    </button>
  );
}
