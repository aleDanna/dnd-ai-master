'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Field, TextArea } from '@/components/ui/field';
import { CAMPAIGN_PRESETS, DEFAULT_PRESET_ID, getPresetById } from '@/sessions/campaign-presets';

export interface CharSummary {
  id: string;
  name: string;
  raceSlug: string;
  classSlug: string;
  level: number;
}

const CUSTOM_ID = 'custom';

export function NewSessionClient({ characters }: { characters: CharSummary[] }) {
  const router = useRouter();
  const [characterId, setCharacterId] = React.useState<string | null>(characters[0]?.id ?? null);
  const [presetId, setPresetId] = React.useState<string>(DEFAULT_PRESET_ID);
  const [premise, setPremise] = React.useState<string>(getPresetById(DEFAULT_PRESET_ID)?.premise ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onPickPreset = (id: string): void => {
    setPresetId(id);
    if (id === CUSTOM_ID) {
      setPremise('');
      return;
    }
    const preset = getPresetById(id);
    if (preset) setPremise(preset.premise);
  };

  // If the user edits the textarea after picking a preset, switch to "custom".
  const onPremiseChange = (value: string): void => {
    setPremise(value);
    if (presetId !== CUSTOM_ID) {
      const current = getPresetById(presetId);
      if (!current || value !== current.premise) setPresetId(CUSTOM_ID);
    }
  };

  async function start(): Promise<void> {
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
        const body = (await res.json().catch(() => ({}))) as { error?: string };
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
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 32px' }}>
      <h1 style={{ fontSize: 36, fontWeight: 600 }}>Open the table</h1>
      <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
        Pick a hero, choose a campaign, and the Master will take it from there.
      </p>

      {/* ─── Character picker ───────────────────────────────────────────── */}
      <div style={{ marginTop: 24 }}>
        <Eyebrow style={{ marginBottom: 8 }}>Character</Eyebrow>
        {characters.length === 0 ? (
          <Card>
            <div>You have no characters yet. <Link href="/characters/new" style={{ color: 'var(--arcane)' }}>Roll one</Link> first.</div>
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

      {/* ─── Campaign picker ────────────────────────────────────────────── */}
      <div style={{ marginTop: 28 }}>
        <Eyebrow style={{ marginBottom: 8 }}>Campaign</Eyebrow>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {CAMPAIGN_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => onPickPreset(p.id)}
              style={{
                textAlign: 'left',
                padding: 14,
                borderRadius: 8,
                background: 'var(--bg-card)',
                border: presetId === p.id ? '2px solid var(--arcane)' : '1px solid var(--border)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{p.name}</div>
                <Chip tone={p.difficulty === 'novice' ? 'accent' : p.difficulty === 'gritty' ? 'warn' : 'neutral'}>
                  {p.difficulty}
                </Chip>
              </div>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.45 }}>{p.blurb}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 'auto' }}>
                {p.themes.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: 10,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--fg-subtle)',
                      padding: '2px 6px',
                      border: '1px solid var(--border)',
                      borderRadius: 999,
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
          {/* Custom option */}
          <button
            onClick={() => onPickPreset(CUSTOM_ID)}
            style={{
              textAlign: 'left',
              padding: 14,
              borderRadius: 8,
              background: 'transparent',
              border: presetId === CUSTOM_ID ? '2px solid var(--arcane)' : '1px dashed var(--border-strong)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, color: 'var(--fg)' }}>Custom premise</div>
            <div style={{ fontSize: 13, lineHeight: 1.45 }}>Write your own setup. Free-form.</div>
          </button>
        </div>
      </div>

      {/* ─── Premise textarea (always visible — editable on top of any preset) ── */}
      <div style={{ marginTop: 24 }}>
        <Field label={presetId === CUSTOM_ID ? 'Premise — write your setup (1–3 sentences)' : 'Premise — edit if you want to tweak this campaign'}>
          <TextArea rows={5} value={premise} onChange={(e) => onPremiseChange(e.target.value)} />
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
