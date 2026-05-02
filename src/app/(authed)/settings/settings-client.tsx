'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import { TTS_VOICES } from '@/lib/tts-voices';
import {
  modelsForProvider,
  defaultModelForProvider,
  type ProviderName,
} from '@/lib/ai-models';
import type { UserPreferences } from '@/db/schema/users';

export interface SettingsClientProps {
  initialPreferences: Required<UserPreferences>;
  ttsModel: string;
}

export function SettingsClient({ initialPreferences, ttsModel }: SettingsClientProps) {
  const [prefs, setPrefs] = React.useState<Required<UserPreferences>>(initialPreferences);
  const [busy, setBusy] = React.useState(false);
  const [savedOnce, setSavedOnce] = React.useState(false);
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
      setSavedOnce(true);
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

  const onManualRollsToggle = (): void => {
    const next = !prefs.manualRolls;
    setPrefs((p) => ({ ...p, manualRolls: next }));
    void save({ manualRolls: next });
  };

  const onProviderChange = (next: ProviderName): void => {
    if (next === prefs.aiProvider) return;
    const nextModel = defaultModelForProvider(next);
    setPrefs((p) => ({ ...p, aiProvider: next, aiMasterModel: nextModel }));
    void save({ aiProvider: next, aiMasterModel: nextModel });
  };

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setPrefs((p) => ({ ...p, aiMasterModel: slug }));
    void save({ aiMasterModel: slug });
  };

  const availableModels = modelsForProvider(prefs.aiProvider);

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
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Provider &amp; model</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Drives the master narration and AI character-builder proposals. Each user picks their own.
          </p>
        </div>

        {/* Provider radio segments */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="provider" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>
            Provider
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['anthropic', 'openai'] as ProviderName[]).map((p) => (
              <button
                key={p}
                onClick={() => onProviderChange(p)}
                disabled={busy}
                aria-pressed={prefs.aiProvider === p}
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: prefs.aiProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                  color: prefs.aiProvider === p ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (prefs.aiProvider === p ? 'var(--arcane)' : 'var(--border)'),
                  cursor: busy ? 'wait' : 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
              </button>
            ))}
          </div>
        </div>

        {/* Model dropdown filtered by current provider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="masterModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>
            Model
          </label>
          <select
            id="masterModel"
            value={prefs.aiMasterModel}
            onChange={onModelChange}
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
            {availableModels.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}
              </option>
            ))}
          </select>
        </div>
        <p style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          The selected provider must have a valid API key configured server-side. Picking a model your account doesn&apos;t have access to will surface as an error at the next turn.
        </p>
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

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Dice rolls</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Auto-roll: the AI uses its tools to compute attacks, saves and damage server-side. Manual: the master asks you to roll your physical dice and report the total — your number is authoritative.
          </p>
        </div>
        <button
          onClick={onManualRollsToggle}
          disabled={busy}
          aria-pressed={prefs.manualRolls}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            height: 36,
            padding: '0 14px',
            background: prefs.manualRolls ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (prefs.manualRolls ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999,
            color: prefs.manualRolls ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          <Icon name="dice" size={14} />
          {prefs.manualRolls ? 'Manual rolls' : 'Auto-rolls'}
        </button>
      </Card>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', minHeight: 18 }}>
        {error ? (
          <span style={{ color: 'var(--ember)' }}>Save failed: {error}</span>
        ) : busy ? (
          <span>Saving…</span>
        ) : savedOnce ? (
          <span>Saved.</span>
        ) : null}
      </div>
    </div>
  );
}
