'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export interface DeleteResourceButtonProps {
  /** REST endpoint to DELETE — e.g. `/api/characters/${id}` or `/api/campaigns/${id}`. */
  endpoint: string;
  /** Browser-confirm prompt — e.g. "Delete Tharion? This cannot be undone." */
  confirmText: string;
  /**
   * Where to send the user after a successful delete. The current detail page
   * would 404 on next render (the resource is now soft-deleted), so the caller
   * MUST pick a destination — typically the list view above (`/hub`,
   * `/campaigns`).
   */
  redirectTo: string;
  /** Label shown in the button. Defaults to "Delete". */
  label?: string;
}

/**
 * Header-style destructive Delete button for detail pages
 * (character detail, campaign detail).
 *
 * Lives in normal flex flow (unlike `DeleteCardButton`, which is an absolutely
 * positioned "×" anchored to a card cell). The header version is impossible to
 * miss — its label says "Delete" and the click runs through the standard
 * browser-confirm prompt before hitting the DELETE endpoint.
 *
 * On success we `router.replace(redirectTo)` (history-replacing so Back
 * doesn't return to the now-404 page) and then `router.refresh()` so the
 * destination's server components re-render without the deleted row.
 */
export function DeleteResourceButton({
  endpoint,
  confirmText,
  redirectTo,
  label = 'Delete',
}: DeleteResourceButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = async (): Promise<void> => {
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
      router.replace(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="md"
      icon="x"
      onClick={onClick}
      disabled={busy}
      title={error ?? undefined}
    >
      {busy ? 'Deleting…' : label}
    </Button>
  );
}
