'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';
import { SpinningDie } from './spinning-die';
import { setActiveAudio, subscribePlayback, getActiveAudio, getActiveMessageId } from '@/lib/tts-playback';

export interface TtsButtonProps {
  sessionId: string;
  messageId: string;
}

type State = 'idle' | 'loading' | 'playing' | 'error';

/**
 * Small inline play/pause button for synthesizing and playing back the master's text.
 * Caches the blob URL across plays in the same component lifetime; revokes on unmount.
 * Each first-play hits /api/sessions/[id]/messages/[messageId]/tts which calls OpenAI.
 *
 * When the page-level auto-play coordinator starts an audio tagged with our
 * messageId, we adopt that audio so clicking the button pauses it (UI shows
 * "Pause" instead of the stale "Listen").
 */
export function TtsButton({ sessionId, messageId }: TtsButtonProps) {
  const [state, setState] = React.useState<State>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const urlRef = React.useRef<string | null>(null);

  React.useEffect(
    () => () => {
      // Only clean up if we own the audio — autoplay coordinator owns its own.
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  // Mount-time adoption: if the page-level autoplay coordinator already
  // started an audio for OUR messageId before we mounted, pick it up so the
  // initial render shows "Pause" instead of a stale "Listen".
  React.useEffect(() => {
    if (getActiveMessageId() === messageId) {
      const audio = getActiveAudio();
      if (audio && !audio.paused) {
        audioRef.current = audio;
        setState('playing');
        const onEnded = () => setState('idle');
        audio.addEventListener('ended', onEnded, { once: true });
        return () => audio.removeEventListener('ended', onEnded);
      }
    }
    return undefined;
  }, [messageId]);

  // Live coordination:
  //  - If a NEW audio is registered for OUR messageId, adopt it so the button
  //    reflects "Pause" while the autoplay coordinator drives the playback.
  //  - If a different audio is registered, drop our visual "playing" state.
  React.useEffect(() => {
    return subscribePlayback((active, activeMsgId) => {
      if (active && activeMsgId === messageId) {
        audioRef.current = active;
        setState('playing');
        const onEnded = () => {
          if (audioRef.current === active) {
            audioRef.current = null;
            setState('idle');
          }
        };
        active.addEventListener('ended', onEnded, { once: true });
        return;
      }
      if (audioRef.current && active !== audioRef.current) {
        setState((s) => (s === 'playing' ? 'idle' : s));
      }
    });
  }, [messageId]);

  const playFromUrl = (url: string): void => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setState('idle');
    audio.onerror = () => {
      setState('error');
      setError('playback-failed');
    };
    setState('playing');
    setActiveAudio(audio, messageId);
    void audio.play().catch(() => {
      setState('error');
      setError('playback-blocked');
    });
  };

  const onClick = async (): Promise<void> => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setActiveAudio(null);
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
