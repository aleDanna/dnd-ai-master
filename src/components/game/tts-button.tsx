'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';
import { SpinningDie } from './spinning-die';

export interface TtsButtonProps {
  sessionId: string;
  messageId: string;
}

type State = 'idle' | 'loading' | 'playing' | 'error';

/**
 * Small inline play/pause button for synthesizing and playing back the master's text.
 * Caches the blob URL across plays in the same component lifetime; revokes on unmount.
 * Each first-play hits /api/sessions/[id]/messages/[messageId]/tts which calls OpenAI.
 */
export function TtsButton({ sessionId, messageId }: TtsButtonProps) {
  const [state, setState] = React.useState<State>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const urlRef = React.useRef<string | null>(null);

  React.useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const playFromUrl = (url: string): void => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setState('idle');
    audio.onerror = () => {
      setState('error');
      setError('playback-failed');
    };
    setState('playing');
    void audio.play().catch(() => {
      setState('error');
      setError('playback-blocked');
    });
  };

  const onClick = async (): Promise<void> => {
    if (state === 'playing') {
      audioRef.current?.pause();
      audioRef.current = null;
      setState('idle');
      return;
    }
    if (state === 'loading') return;

    setError(null);

    if (urlRef.current) {
      playFromUrl(urlRef.current);
      return;
    }

    setState('loading');
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages/${messageId}/tts`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      playFromUrl(url);
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'unknown');
    }
  };

  const label =
    state === 'playing' ? 'Pause' : state === 'loading' ? 'Loading…' : state === 'error' ? 'Retry' : 'Listen';

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
        background: state === 'error' ? 'rgba(196, 95, 71, 0.10)' : 'transparent',
        border: '1px solid ' + (state === 'error' ? 'var(--ember)' : 'var(--border)'),
        borderRadius: 999,
        color: state === 'error' ? 'var(--ember)' : 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        cursor: state === 'loading' ? 'wait' : 'pointer',
      }}
    >
      {state === 'loading' ? (
        <SpinningDie size={11} />
      ) : state === 'playing' ? (
        <Icon name="pause" size={11} />
      ) : (
        <Icon name="volume" size={11} />
      )}
      <span>{label}</span>
    </button>
  );
}
