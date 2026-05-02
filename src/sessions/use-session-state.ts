'use client';
import * as React from 'react';
import type { StateSnapshot } from './client-types';

/** Subscribes to /api/sessions/[id]/state via EventSource, exposing the latest snapshot. */
export function useSessionState(sessionId: string): { snapshot: StateSnapshot | null; error: string | null } {
  const [snapshot, setSnapshot] = React.useState<StateSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/state`);
    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as StateSnapshot;
        setSnapshot(parsed);
      } catch {
        // ignore
      }
    });
    es.addEventListener('error', () => setError('connection_lost'));
    return () => es.close();
  }, [sessionId]);

  return { snapshot, error };
}
