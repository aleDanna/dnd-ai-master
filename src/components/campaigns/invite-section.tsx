'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Invite = {
  id: string;
  token: string;
  expiresAt: string | null;
  maxUses: number | null;
  usesCount: number;
};

export function InviteSection({ campaignId, initial }: { campaignId: string; initial: { invites: Invite[] } }) {
  const [invites, setInvites] = useState<Invite[]>(initial.invites);
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const onGenerate = async () => {
    setBusy(true);
    const res = await fetch(`/api/campaigns/${campaignId}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const { invite } = await res.json();
      setInvites((prev) => [invite, ...prev]);
    }
    setBusy(false);
  };

  const onRevoke = async (id: string) => {
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/invites/${id}`, { method: 'DELETE' });
    setInvites((prev) => prev.filter((i) => i.id !== id));
    setBusy(false);
  };

  const onCopy = (token: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(`${origin}/r/${token}`);
    }
  };

  if (invites.length === 0) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
              Invite link
            </div>
            <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 4 }}>
              No active invite. Generate one to invite friends.
            </div>
          </div>
          <Button variant="primary" size="md" onClick={onGenerate} disabled={busy}>
            Generate invite link
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {invites.map((inv) => (
        <Card key={inv.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
                Invite link
              </div>
              <code style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 13, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {origin}/r/{inv.token}
              </code>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
                {inv.expiresAt ? `Expires ${new Date(inv.expiresAt).toLocaleString()} · ` : 'No expiry · '}
                {inv.maxUses !== null ? `${inv.usesCount}/${inv.maxUses} uses` : `${inv.usesCount} uses`}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => onCopy(inv.token)}>Copy</Button>
            <Button variant="ghost" size="sm" onClick={() => onRevoke(inv.id)} disabled={busy}>Revoke</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
