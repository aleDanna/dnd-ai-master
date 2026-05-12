'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/icon';

export interface DeleteCardButtonProps {
  /** REST endpoint to call with DELETE — e.g., `/api/characters/${id}` or `/api/sessions/${id}`. */
  endpoint: string;
  /** Browser-confirm prompt text — e.g., "Delete Tharion? This cannot be undone." */
  confirmText: string;
  /** If provided, called after a successful delete. Defaults to router.refresh() to revalidate the parent server component. */
  onDeleted?: () => void;
  /** If true, the parent <Link> won't follow the click. */
  stopLinkPropagation?: boolean;
}

/**
 * Tiny absolute-positioned × button. Drop it inside a card that has
 * `position: relative` to anchor the top-right placement.
 *
 * Note: when used inside a <Link>, the click handler calls preventDefault +
 * stopPropagation so the outer link does not navigate. Passes through
 * window.confirm before invoking the destructive endpoint.
 */
export function DeleteCardButton({ endpoint, confirmText, onDeleted, stopLinkPropagation = true }: DeleteCardButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (stopLinkPropagation) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (busy) return;
    if (typeof window !== 'undefined' && !window.confirm(confirmText)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      if (onDeleted) onDeleted();
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={error ?? 'Delete'}
      aria-label="Delete"
      // Anchored via `style.position` so we beat any z-index stacking from
      // sibling content; `zIndex: 2` keeps us above accent borders and the
      // card's box-shadow.
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 2,
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        // Stronger default contrast — the previous 55% opacity + muted text
        // on a dark card was almost invisible, leading users to think the
        // affordance didn't exist. Now: solid dark fill, brighter foreground,
        // visible border. Hover bumps to ember red (destructive intent).
        background: error ? 'rgba(196, 95, 71, 0.22)' : 'var(--bg-sunken)',
        border: '1px solid ' + (error ? 'var(--ember)' : 'var(--border-strong)'),
        borderRadius: 999,
        color: error ? 'var(--ember)' : 'var(--fg)',
        cursor: busy ? 'wait' : 'pointer',
        opacity: 0.92,
        transition: 'opacity 150ms ease-out, background 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '1';
        if (!error) {
          e.currentTarget.style.color = 'var(--ember)';
          e.currentTarget.style.background = 'rgba(196, 95, 71, 0.22)';
          e.currentTarget.style.borderColor = 'var(--ember)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '0.92';
        if (!error) {
          e.currentTarget.style.color = 'var(--fg)';
          e.currentTarget.style.background = 'var(--bg-sunken)';
          e.currentTarget.style.borderColor = 'var(--border-strong)';
        }
      }}
    >
      <Icon name="x" size={14} />
    </button>
  );
}
