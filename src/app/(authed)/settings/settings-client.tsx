'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import { TTS_VOICES } from '@/lib/tts-voices';
import type { UserPreferences } from '@/db/schema/users';

export interface SettingsClientProps {
  initialPreferences: Required<UserPreferences>;
  masterProvider: 'anthropic' | 'openai';
  ttsModel: string;
}

export function SettingsClient({ initialPreferences, masterProvider, ttsModel }: SettingsClientProps) {
  const [prefs, setPrefs] = React.useState<Required<UserPreferences>>(initialPreferences);
  const [busy, setBusy] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const save = async (patch: Partial<UserPreferences>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { preferences } = (await res.json()) as { preferences: UserPreferences };
      setPrefs((p) => ({ ...p, ...preferences }));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const onVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const value = e.target.value;
    setPrefs((p) => ({ ...p, ttsVoice: value }));
    void save({ ttsVoice: value });
  };

  const onAutoplayToggle = (): void => {
    const next = !prefs.ttsAutoplay;
    setPrefs((p) => ({ ...p, ttsAutoplay: next }));
    void save({ ttsAutoplay: next });
  };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 36, fontWeight: 600 }}>Settings</h1>
          <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            Tune the Master&apos;s voice and how it behaves at the table.
          </p>
        </div>
        <Link href="/hub">
          <Button variant="ghost" size="md" icon="arrow-left">Back to hub</Button>
        </Link>
      </div>

      <Card>
        <div>
          <Eyebrow>AI master</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Provider</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Chip tone={masterProvider === 'openai' ? 'gold' : 'accent'} dot>
            {masterProvider === 'openai' ? 'OpenAI' : 'Anthropic'}
          </Chip>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Server-side env (<code style={{ fontFamily: 'var(--font-mono)' }}>MASTER_PROVIDER</code>) — change requires a redeploy.
          </span>
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Voice</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Master voice (TTS)</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            OpenAI <code style={{ fontFamily: 'var(--font-mono)' }}>{ttsModel}</code>. Applies to every &ldquo;Listen&rdquo; click on the master&apos;s messages.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsVoice" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            Voice
          </label>
          <select
            id="ttsVoice"
            value={prefs.ttsVoice}
            onChange={onVoiceChange}
            disabled={busy}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              color: 'var(--fg)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
            }}
          >
            {TTS_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Auto-play</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            When on, the master&apos;s response is read aloud automatically as soon as the turn finishes.
          </p>
        </div>
        <button
          onClick={onAutoplayToggle}
          disabled={busy}
          aria-pressed={prefs.ttsAutoplay}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            height: 36,
            padding: '0 14px',
            background: prefs.ttsAutoplay ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (prefs.ttsAutoplay ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999,
            color: prefs.ttsAutoplay ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          <Icon name="volume" size={14} />
          {prefs.ttsAutoplay ? 'Auto-play ON' : 'Auto-play OFF'}
        </button>
      </Card>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', minHeight: 18 }}>
        {error ? (
          <span style={{ color: 'var(--ember)' }}>Save failed: {error}</span>
        ) : busy ? (
          <span>Saving…</span>
        ) : savedAt ? (
          <span>Saved.</span>
        ) : null}
      </div>
    </div>
  );
}
