'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';

export interface AutoplayToggleProps {
  initial: boolean;
  /** Called when the user toggles. The component still owns local state for instant UI feedback. */
  onChange?: (value: boolean) => void;
}

/** Compact pill button — fits in the game-screen header. Posts to /api/preferences on click. */
export function AutoplayToggle({ initial, onChange }: AutoplayToggleProps) {
  const [enabled, setEnabled] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);

  const onClick = async (): Promise<void> => {
    if (busy) return;
    const next = !enabled;
    setEnabled(next); // optimistic
    setBusy(true);
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttsAutoplay: next }),
      });
      if (!res.ok) {
        // Revert on failure
        setEnabled(!next);
      } else {
        onChange?.(next);
      }
    } catch {
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-pressed={enabled}
      title={enabled ? 'Auto-play is ON — click to turn off' : 'Auto-play is OFF — click to turn on'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        background: enabled ? 'rgba(122,79,184,0.20)' : 'transparent',
        border: '1px solid ' + (enabled ? 'var(--arcane)' : 'var(--border)'),
        borderRadius: 999,
        color: enabled ? 'var(--arcane)' : 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        fontWeight: 600,
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      <Icon name="volume" size={12} />
      {enabled ? 'Auto-play' : 'Manual'}
    </button>
  );
}
