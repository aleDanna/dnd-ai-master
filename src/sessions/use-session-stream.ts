'use client';

import { useEffect, useState, useCallback } from 'react';

export type SessionSnapshot = {
  session: any;
  campaign: any;
  state: any;
  character: any;
  party: any[];
  currentPlayerCharacterId: string | null;
  viewerCharacterId: string | null;
};

export type StreamingMessage = { text: string; messageId?: string } | null;

export function useSessionStream(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (res.ok) setSnapshot(await res.json());
  }, [sessionId]);

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
            setStreamingMessage((prev) => ({
              text: (prev?.text ?? '') + ev.text,
              messageId: ev.messageId,
            }));
            break;
          case 'message':
            setStreamingMessage(null);
            refetch();
            break;
          case 'state':
          case 'dice':
            refetch();
            break;
          case 'turn-change':
            setSnapshot((s) => (s ? { ...s, currentPlayerCharacterId: ev.characterId } : s));
            break;
        }
      } catch (err) {
        console.error('parse SSE event failed', err);
      }
    };
    es.onerror = () => setError('connection_lost');
    return () => es.close();
  }, [sessionId, refetch]);

  return { snapshot, streamingMessage, error, refetch };
}
