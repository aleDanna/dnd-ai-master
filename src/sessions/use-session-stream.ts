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
  // Monotonic counter that increments every time a turn finalizes (a master
  // `message` event, or a `turn-error`). The game-client subscribes to this
  // so it can refetch the messages list even when the prior `message-chunk`
  // events never arrived — historically the messages refetch was gated on a
  // `streamingMessage` non-null → null transition, which never fires when
  // the SSE chunks drop in transit and only the final `message` event lands.
  // After: the message body shows up without a page refresh either way.
  const [finalizedSeq, setFinalizedSeq] = useState(0);
  const [ttsPending, setTtsPending] = useState<Set<string>>(new Set());
  const [ttsErrors, setTtsErrors] = useState<Map<string, string>>(new Map());
  const [imagePending, setImagePending] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (res.ok) setSnapshot(await res.json());
  }, [sessionId]);

  const clearTurnError = useCallback(() => setTurnError(null), []);

  // Used by the safety poll path when the SSE delivered `message-chunk`
  // events but the final `message` event got dropped: without this the
  // streaming buffer stays non-null forever, holding `busy=true` and
  // locking the composer even though the master's reply has already
  // landed in the messages list.
  const clearStreamingMessage = useCallback(() => setStreamingMessage(null), []);

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
            setFinalizedSeq((s) => s + 1);
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
            // Bump finalizedSeq so the game-client refetches messages — a
            // failed turn can still have persisted mutations (xp, items)
            // upstream of the narration crash.
            setFinalizedSeq((s) => s + 1);
            // Refetch so we pick up any mutations the failed turn DID persist
            // (xp, inventory, etc. can land even when narration didn't).
            refetch();
            break;
          case 'tts-pending':
            setTtsPending((prev) => {
              if (prev.has(ev.messageId)) return prev;
              const next = new Set(prev);
              next.add(ev.messageId);
              return next;
            });
            setTtsErrors((prev) => {
              if (!prev.has(ev.messageId)) return prev;
              const next = new Map(prev);
              next.delete(ev.messageId);
              return next;
            });
            break;
          case 'tts-ready':
            setTtsPending((prev) => {
              if (!prev.has(ev.messageId)) return prev;
              const next = new Set(prev);
              next.delete(ev.messageId);
              return next;
            });
            break;
          case 'tts-failed':
            setTtsPending((prev) => {
              if (!prev.has(ev.messageId)) return prev;
              const next = new Set(prev);
              next.delete(ev.messageId);
              return next;
            });
            setTtsErrors((prev) => new Map(prev).set(ev.messageId, ev.reason ?? 'failed'));
            setTimeout(() => {
              setTtsErrors((prev) => {
                if (!prev.has(ev.messageId)) return prev;
                const next = new Map(prev);
                next.delete(ev.messageId);
                return next;
              });
            }, 5_000);
            break;
          case 'image-pending':
            setImagePending(true);
            setImageError(null);
            break;
          case 'image-ready':
            setImagePending(false);
            void refetch();
            break;
          case 'image-failed':
            setImagePending(false);
            setImageError(ev.reason ?? 'failed');
            setTimeout(() => setImageError(null), 5_000);
            break;
        }
      } catch (err) {
        console.error('parse SSE event failed', err);
      }
    };
    es.onerror = () => setError('connection_lost');
    return () => es.close();
  }, [sessionId, refetch]);

  return {
    snapshot,
    streamingMessage,
    error,
    turnError,
    finalizedSeq,
    refetch,
    clearTurnError,
    clearStreamingMessage,
    ttsPending,
    ttsErrors,
    imagePending,
    imageError,
  };
}
