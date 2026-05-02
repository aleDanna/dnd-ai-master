'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Field, TextArea } from '@/components/ui/field';

export interface CharSummary {
  id: string;
  name: string;
  raceSlug: string;
  classSlug: string;
  level: number;
}

export function NewSessionClient({ characters }: { characters: CharSummary[] }) {
  const router = useRouter();
  const [characterId, setCharacterId] = React.useState<string | null>(characters[0]?.id ?? null);
  const [premise, setPremise] = React.useState('A goblin warren beneath an old mill. Heavy rain outside, dim torchlight inside.');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    if (!characterId || !premise.trim()) {
      setError('Pick a character and write a premise.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterId, premise: premise.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/sessions/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 32px' }}>
      <h1 style={{ fontSize: 36, fontWeight: 600 }}>Open the table</h1>
      <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
        Pick a hero and set the scene. The Master will take it from there.
      </p>

      <div style={{ marginTop: 24 }}>
        <Eyebrow style={{ marginBottom: 8 }}>Character</Eyebrow>
        {characters.length === 0 ? (
          <Card>
            <div>You have no characters yet. <a href="/characters/new" style={{ color: 'var(--arcane)' }}>Roll one</a> first.</div>
          </Card>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {characters.map((c) => (
              <button
                key={c.id}
                onClick={() => setCharacterId(c.id)}
                style={{
                  textAlign: 'left',
                  padding: 14,
                  borderRadius: 8,
                  background: 'var(--bg-card)',
                  border: characterId === c.id ? '2px solid var(--arcane)' : '1px solid var(--border)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  color: 'inherit',
                }}
              >
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{c.raceSlug} · {c.classSlug} {c.level}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <Field label="Premise (1-2 sentences — what's the setup?)">
          <TextArea rows={4} value={premise} onChange={(e) => setPremise(e.target.value)} />
        </Field>
      </div>

      {error && <div style={{ marginTop: 12, color: 'var(--ember)' }}>{error}</div>}

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="secondary" size="md" onClick={() => router.push('/sessions')}>Cancel</Button>
        <Button variant="primary" size="md" iconRight="arrow-right" onClick={start} disabled={busy || !characterId || !premise.trim()}>
          {busy ? 'Opening…' : 'Begin session'}
        </Button>
      </div>
    </div>
  );
}
