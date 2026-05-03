'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';
import { SpinningDie } from './spinning-die';

export interface SceneImageButtonProps {
  sessionId: string;
  messageId: string;
}

type State = 'idle' | 'loading' | 'done' | 'error';

/**
 * Manual scene-image trigger. Sits next to TtsButton on each persisted master
 * message. Click → POST /api/sessions/[id]/messages/[messageId]/scene-image,
 * which generates the image and updates session_state. The actual image
 * rendering happens in the right Scene panel; this button is just the
 * trigger + loading/error feedback.
 */
export function SceneImageButton({ sessionId, messageId }: SceneImageButtonProps) {
  const [state, setState] = React.useState<State>('idle');
  const [error, setError] = React.useState<string | null>(null);

  const onClick = async (): Promise<void> => {
    if (state === 'loading') return;
    setError(null);
    setState('loading');
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/messages/${messageId}/scene-image`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setState('done');
      // Auto-reset to idle after a short success window so the user can
      // re-trigger (e.g. for a different style).
      setTimeout(() => setState((s) => (s === 'done' ? 'idle' : s)), 4000);
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'unknown');
    }
  };

  const label =
    state === 'loading'
      ? 'Generating…'
      : state === 'done'
        ? 'Generated'
        : state === 'error'
          ? 'Retry'
          : 'Image';

  return (
    <button
      onClick={onClick}
      title={error ?? label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        background:
          state === 'error'
            ? 'rgba(196, 95, 71, 0.10)'
            : state === 'done'
              ? 'rgba(122, 79, 184, 0.10)'
              : 'transparent',
        border:
          '1px solid ' +
          (state === 'error' ? 'var(--ember)' : state === 'done' ? 'var(--arcane)' : 'var(--border)'),
        borderRadius: 999,
        color:
          state === 'error' ? 'var(--ember)' : state === 'done' ? 'var(--arcane)' : 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        cursor: state === 'loading' ? 'wait' : 'pointer',
      }}
    >
      {state === 'loading' ? (
        <SpinningDie size={11} />
      ) : state === 'done' ? (
        <Icon name="check" size={11} />
      ) : (
        <Icon name="sparkle" size={11} />
      )}
      <span>{label}</span>
    </button>
  );
}
