'use client';

import { useEffect, useState, useCallback } from 'react';

export type SessionSnapshot = {
  session: any;
  campaign: any;
  state: any;
  character: any;
  party: any[];
  actors?: any[];
  currentPlayerCharacterId: string | null;
  viewerCharacterId: string | null;
};

export type StreamingMessage = { text: string; messageId?: string } | null;

/** Hint that the master produced no narration (or crashed) — surfaced to
 *  the UI as a transient error toast so the composer unlocks. */
export type TurnError = { reason: 'empty_response' | 'failed'; message?: string } | null;

export function useSessionStream(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage>(null);
  const [error, setError] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<TurnError>(null);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (res.ok) setSnapshot(await res.json());
  }, [sessionId]);

  const clearTurnError = useCallback(() => setTurnError(null), []);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        switch (ev.type) {
          case 'snapshot':
            setSnapshot(ev.snapshot);
            setError(null);
            break;
          case 'message-chunk':
            // Receiving narration means the master is responding — clear any
            // prior "empty response" error from the previous attempt.
            setTurnError(null);
            setStreamingMessage((prev) => ({
              text: (prev?.text ?? '') + ev.text,
              messageId: ev.messageId,
            }));
            break;
          case 'message':
            setStreamingMessage(null);
            setTurnError(null);
            refetch();
            break;
          case 'state':
          case 'dice':
            refetch();
            break;
          case 'turn-change':
            setSnapshot((s) => (s ? { ...s, currentPlayerCharacterId: ev.characterId } : s));
            break;
          case 'turn-error':
            // Master finished without persisting narration (or crashed).
            // Surface to the UI so the player can re-prompt, AND clear any
            // streaming buffer so the composer can unlock.
            setStreamingMessage(null);
            setTurnError({ reason: ev.reason ?? 'failed', message: ev.message });
            // Refetch so we pick up any mutations the failed turn DID persist
            // (xp, inventory, etc. can land even when narration didn't).
            refetch();
            break;
        }
      } catch (err) {
        console.error('parse SSE event failed', err);
      }
    };
    es.onerror = () => setError('connection_lost');
    return () => es.close();
  }, [sessionId, refetch]);

  return { snapshot, streamingMessage, error, turnError, clearTurnError, refetch };
}
