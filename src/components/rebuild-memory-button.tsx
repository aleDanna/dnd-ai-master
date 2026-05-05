'use client';

import { useState } from 'react';

interface Props {
  sessionId: string;
}

export function RebuildMemoryButton({ sessionId }: Props): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/memory/rebuild`, { method: 'POST' });
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        setRunning(false);
        return;
      }
      // Drain the SSE stream silently — the in-page banner mounted on the
      // session chat surfaces user-visible progress; this button just
      // initiates and waits for completion.
      const reader = r.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      // Reload the page so the banner runs `/memory/status` again and the
      // master sees the fresh codex on the next turn.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };

  if (running) {
    return (
      <div data-testid="rebuild-memory-running" className="text-sm">
        Ricostruzione memoria in corso…
      </div>
    );
  }
  if (error) {
    return (
      <div data-testid="rebuild-memory-error" className="text-sm text-red-600">
        Errore: {error}
        <button
          type="button"
          className="ml-2 underline"
          onClick={() => {
            setError(null);
            setConfirming(false);
          }}
        >
          OK
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="rebuild-memory-button"
      onClick={() => (confirming ? trigger() : setConfirming(true))}
      className="rounded bg-amber-600 px-3 py-1 text-sm text-white hover:bg-amber-700"
    >
      {confirming
        ? 'Confermi? Cancellerà tutta la memoria attuale e la rigenererà.'
        : 'Ricostruisci memoria'}
    </button>
  );
}
