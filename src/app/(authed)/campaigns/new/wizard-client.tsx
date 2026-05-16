'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CampaignPreset } from '@/sessions/campaign-presets';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type TemplateOpt = { id: string; name: string; raceSlug: string; classSlug: string; level: number };

export function NewCampaignWizard({ templates, presets }: { templates: TemplateOpt[]; presets: CampaignPreset[] }) {
  const router = useRouter();
  const [step, setStep] = useState<0 | 1>(0);
  const [characterId, setCharacterId] = useState<string>(templates[0]?.id ?? '');
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? 'custom');
  const preset = presets.find((p) => p.id === presetId);
  const [premise, setPremise] = useState<string>(preset?.premise ?? '');
  const [name, setName] = useState<string>(preset?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPresetChange = (id: string) => {
    setPresetId(id);
    if (id === 'custom') {
      setPremise('');
      setName('');
    } else {
      const p = presets.find((x) => x.id === id);
      if (p) {
        setPremise(p.premise);
        setName(p.name);
      }
    }
  };

  const onCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'Untitled', premise: premise.trim(), characterTemplateId: characterId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { campaign, sessionId } = (await res.json()) as { campaign: { id: string }; sessionId: string };
      // Detour through Campaign Settings so the player can pick provider/model
      // before the first turn. The settings page renders a "Start campaign"
      // CTA when `first=1` is set; clicking it does the final hop to /sessions/{id}.
      router.push(`/campaigns/${campaign.id}/settings?first=1&session=${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 32px' }}>
      <h1 style={{ fontSize: 32, fontWeight: 600 }}>{step === 0 ? 'Who walks the path?' : 'How does the tale begin?'}</h1>

      {step === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginTop: 24 }}>
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setCharacterId(t.id)}
              style={{
                textAlign: 'left', padding: 14, borderRadius: 8,
                background: 'var(--bg-card)',
                border: characterId === t.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{t.raceSlug} · {t.classSlug} · L{t.level}</div>
            </button>
          ))}
        </div>
      )}

      {step === 1 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => onPresetChange(p.id)}
                style={{
                  textAlign: 'left', padding: 12, borderRadius: 8,
                  background: 'var(--bg-card)',
                  border: presetId === p.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                  cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.difficulty}</div>
              </button>
            ))}
            <button
              onClick={() => onPresetChange('custom')}
              style={{
                textAlign: 'left', padding: 12, borderRadius: 8,
                background: 'var(--bg-card)',
                border: presetId === 'custom' ? '2px solid var(--accent)' : '1px dashed var(--border-strong)',
                cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontWeight: 600 }}>Custom…</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>write your own</div>
            </button>
          </div>

          <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>Premise</label>
          <textarea
            value={premise}
            onChange={(e) => setPremise(e.target.value)}
            rows={5}
            style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'inherit', fontFamily: 'inherit', fontSize: 14 }}
          />

          <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 14, marginBottom: 4 }}>Campaign name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="auto-derived from preset"
            style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'inherit', fontFamily: 'inherit', fontSize: 14 }}
          />
        </div>
      )}

      {error && <Card style={{ marginTop: 16, borderColor: 'var(--danger)' }}><div style={{ color: 'var(--danger)' }}>Error: {error}</div></Card>}

      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'space-between' }}>
        {step === 0 ? (
          <Link href="/campaigns" style={{ textDecoration: 'none' }}><Button variant="ghost" size="md">Cancel</Button></Link>
        ) : (
          <Button variant="ghost" size="md" onClick={() => setStep(0)}>Back</Button>
        )}
        {step === 0 ? (
          <Button variant="primary" size="md" iconRight="arrow-right" onClick={() => setStep(1)} disabled={!characterId}>
            Next: Premise
          </Button>
        ) : (
          <Button variant="primary" size="md" icon="sparkle" onClick={onCreate} disabled={submitting || !premise.trim()}>
            {submitting ? 'Forging…' : 'Begin the tale'}
          </Button>
        )}
      </div>
    </div>
  );
}
