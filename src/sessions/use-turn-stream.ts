'use client';
import * as React from 'react';
import type { TurnEvent } from './types';

export interface UseTurnStreamResult {
  busy: boolean;
  events: TurnEvent[];
  send: (message: string) => Promise<void>;
  error: string | null;
  reset: () => void;
}

/** Sends a player message to the turn endpoint and consumes the SSE stream.
 *  Buffers events; the consuming component re-renders as the array grows. */
export function useTurnStream(sessionId: string): UseTurnStreamResult {
  const [busy, setBusy] = React.useState(false);
  const [events, setEvents] = React.useState<TurnEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const reset = React.useCallback(() => {
    setEvents([]);
    setError(null);
  }, []);

  const send = React.useCallback(async (message: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const block of lines) {
          const evMatch = /^event: (.+)$/m.exec(block);
          const dataMatch = /^data: (.+)$/m.exec(block);
          if (!evMatch || !dataMatch) continue;
          try {
            const parsed = JSON.parse(dataMatch[1]!) as TurnEvent;
            setEvents((prev) => [...prev, parsed]);
          } catch {
            // ignore malformed event
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, sessionId]);

  React.useEffect(() => () => { abortRef.current?.abort(); }, []);

  return { busy, events, send, error, reset };
}
