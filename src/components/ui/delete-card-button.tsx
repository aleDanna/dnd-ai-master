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
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 26,
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        background: error ? 'rgba(196, 95, 71, 0.18)' : 'rgba(20, 16, 28, 0.72)',
        border: '1px solid ' + (error ? 'var(--ember)' : 'var(--border)'),
        borderRadius: 999,
        color: error ? 'var(--ember)' : 'var(--fg-muted)',
        cursor: busy ? 'wait' : 'pointer',
        opacity: 0.55,
        transition: 'opacity 150ms ease-out, background 150ms ease-out, color 150ms ease-out',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '1';
        if (!error) {
          e.currentTarget.style.color = 'var(--ember)';
          e.currentTarget.style.background = 'rgba(196, 95, 71, 0.18)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '0.55';
        if (!error) {
          e.currentTarget.style.color = 'var(--fg-muted)';
          e.currentTarget.style.background = 'rgba(20, 16, 28, 0.72)';
        }
      }}
    >
      <Icon name="x" size={12} />
    </button>
  );
}
