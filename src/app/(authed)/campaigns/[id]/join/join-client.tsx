'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Template = { id: string; name: string; raceSlug: string; classSlug: string; level: number };

export function JoinClient({
  campaignId, campaignName, token, templates,
}: {
  campaignId: string;
  campaignName: string;
  token: string;
  templates: Template[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>(templates[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onJoin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, characterTemplateId: selectedId }),
      });
      if (res.status === 409) {
        const body = await res.json();
        if (body.sessionId) {
          router.push(`/sessions/${body.sessionId}`);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { sessionId } = await res.json();
      router.push(`/sessions/${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 880, margin: '40px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Join {campaignName}</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4 }}>Pick the character you want to play.</p>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 12, marginTop: 24,
      }}>
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedId(t.id)}
            style={{
              textAlign: 'left', padding: 14, borderRadius: 8,
              background: 'var(--bg-card)',
              border: selectedId === t.id ? '2px solid var(--accent)' : '1px solid var(--border)',
              cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
            }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>{t.name}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{t.raceSlug} · {t.classSlug} · L{t.level}</div>
          </button>
        ))}
      </div>

      {error && (
        <Card style={{ marginTop: 16, borderColor: 'var(--danger)' }}>
          <div style={{ color: 'var(--danger)' }}>Error: {error}</div>
        </Card>
      )}

      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          size="md"
          icon="sparkle"
          onClick={onJoin}
          disabled={!selectedId || submitting}
        >
          {submitting ? 'Joining…' : `Join as ${templates.find(t => t.id === selectedId)?.name}`}
        </Button>
      </div>
    </div>
  );
}
