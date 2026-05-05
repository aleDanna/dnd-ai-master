'use client';

import { useEffect, useState } from 'react';

interface Props {
  sessionId: string;
  /** Called when backfill finishes (or when we determine no backfill is needed). */
  onReady: () => void;
}

interface Progress {
  index: number;
  total: number;
}

export function MemoryStatusBanner({ sessionId, onReady }: Props): React.ReactElement | null {
  const [phase, setPhase] = useState<'checking' | 'rebuilding' | 'done' | 'error'>('checking');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    let abort: AbortController | null = null;

    (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/memory/status`);
        if (!res.ok) {
          if (!aborted) {
            setPhase('done');
            onReady();
          }
          return;
        }
        const data = (await res.json()) as { needsBackfill: boolean; messageCount: number };
        if (!data.needsBackfill) {
          if (!aborted) {
            setPhase('done');
            onReady();
          }
          return;
        }

        if (aborted) return;
        setPhase('rebuilding');
        abort = new AbortController();
        const r = await fetch(`/api/sessions/${sessionId}/memory/rebuild`, {
          method: 'POST',
          signal: abort.signal,
        });
        const reader = r.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const p of parts) {
            const ev = p.match(/^event: (.+)$/m)?.[1];
            const dataLine = p.match(/^data: (.+)$/m)?.[1];
            if (!ev || !dataLine) continue;
            const payload = JSON.parse(dataLine) as Progress | { reason?: string; message?: string };
            if (ev === 'chapter_done' && 'index' in payload && 'total' in payload) {
              setProgress(payload as Progress);
            } else if (ev === 'complete') {
              if (!aborted) {
                setPhase('done');
                onReady();
              }
              return;
            } else if (ev === 'error') {
              if (!aborted) {
                setPhase('error');
                setErrorMsg(
                  ('reason' in payload && payload.reason) ||
                    ('message' in payload && payload.message) ||
                    'unknown',
                );
              }
              return;
            }
          }
        }
      } catch (e) {
        if (!aborted) {
          setPhase('error');
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      aborted = true;
      abort?.abort();
    };
  }, [sessionId, onReady]);

  if (phase === 'checking' || phase === 'done') return null;
  if (phase === 'rebuilding') {
    const pct = progress && progress.total > 0 ? Math.floor((progress.index / progress.total) * 100) : 0;
    return (
      <div
        data-testid="memory-status-banner"
        className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm"
      >
        <div>Costruzione memoria della campagna in corso…</div>
        <div className="text-xs opacity-70">
          {progress ? `Capitolo ${progress.index + 1} di ${progress.total}` : 'Inizio…'} ({pct}%)
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid="memory-status-banner-error"
      className="rounded-md border border-red-500/40 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm"
    >
      <div>Errore costruzione memoria: {errorMsg ?? 'unknown'}</div>
      <button
        type="button"
        className="mt-1 text-xs underline"
        onClick={() => window.location.reload()}
      >
        Riprova
      </button>
    </div>
  );
}
