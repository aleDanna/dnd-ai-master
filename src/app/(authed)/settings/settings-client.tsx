'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import { TTS_VOICES, TTS_MODELS, type TtsModel, isValidTtsModel } from '@/lib/tts-voices';
import {
  modelsForProvider,
  defaultModelForProvider,
  imageModelsForProvider,
  defaultImageModelForProvider,
  type ProviderName,
  type ImageProviderName,
} from '@/lib/ai-models';
import type { UserPreferences } from '@/db/schema/users';

export interface SettingsClientProps {
  initialPreferences: Required<UserPreferences>;
}

/** Short, user-facing blurb per OpenAI TTS model. */
const TTS_MODEL_BLURBS: Record<TtsModel, string> = {
  'gpt-4o-mini-tts': 'Newer, voice-steering supported',
  'tts-1': 'Lower latency, slightly less natural',
  'tts-1-hd': 'Higher fidelity, slower & pricier',
};

export function SettingsClient({ initialPreferences }: SettingsClientProps) {
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

  const onTtsModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const value = e.target.value;
    if (!isValidTtsModel(value)) return;
    setPrefs((p) => ({ ...p, ttsModel: value }));
    void save({ ttsModel: value });
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

  const onGuidanceLevelChange = (next: 'free' | 'balanced' | 'structured'): void => {
    if (next === prefs.masterGuidanceLevel) return;
    setPrefs((p) => ({ ...p, masterGuidanceLevel: next }));
    void save({ masterGuidanceLevel: next });
  };

  const onShowDifficultyNumbersToggle = (): void => {
    const next = !prefs.showDifficultyNumbers;
    setPrefs((p) => ({ ...p, showDifficultyNumbers: next }));
    void save({ showDifficultyNumbers: next });
  };

  const onImageGenToggle = (): void => {
    const next = !prefs.imageGenerationEnabled;
    setPrefs((p) => ({ ...p, imageGenerationEnabled: next }));
    void save({ imageGenerationEnabled: next });
  };

  const onImageStylePresetChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value as NonNullable<UserPreferences['imageStylePreset']>;
    if (next === prefs.imageStylePreset) return;
    setPrefs((p) => ({ ...p, imageStylePreset: next }));
    void save({ imageStylePreset: next });
  };

  const onImageStyleCustomChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value;
    setPrefs((p) => ({ ...p, imageStyleCustom: next }));
  };
  const onImageStyleCustomBlur = (): void => {
    void save({ imageStyleCustom: prefs.imageStyleCustom });
  };

  const onImageProviderChange = (next: ImageProviderName): void => {
    if (next === prefs.imageProvider) return;
    const nextModel = defaultImageModelForProvider(next);
    setPrefs((p) => ({ ...p, imageProvider: next, imageModel: nextModel }));
    void save({ imageProvider: next, imageModel: nextModel });
  };

  const onImageModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setPrefs((p) => ({ ...p, imageModel: slug }));
    void save({ imageModel: slug });
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
            {(['anthropic', 'openai', 'gemini'] as ProviderName[]).map((p) => (
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
                {p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : 'Gemini'}
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
            OpenAI text-to-speech. Applies to every &ldquo;Listen&rdquo; click and to auto-play. Changing the model invalidates cached audio for past messages — they&apos;ll re-synthesize on the next click.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 48 }}>
            Model
          </label>
          <select
            id="ttsModel"
            value={prefs.ttsModel}
            onChange={onTtsModelChange}
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
            {TTS_MODELS.map((m) => (
              <option key={m} value={m}>
                {m} — {TTS_MODEL_BLURBS[m]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsVoice" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 48 }}>
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
            Auto-roll: the AI uses its tools to compute attacks, saves and damage server-side. Manual: the master writes the formula and the app shows you a roll button to tap — the result is sent back automatically.
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

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Master guidance</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            How proactively the master suggests possible actions. Lower = more freedom, higher = more on-rails options.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            { slug: 'free' as const, label: 'Free', blurb: 'Pure narration, open prompt' },
            { slug: 'balanced' as const, label: 'Balanced', blurb: 'Hints in prose, no list' },
            { slug: 'structured' as const, label: 'Structured', blurb: 'Numbered choice list' },
          ]).map((opt) => {
            const active = prefs.masterGuidanceLevel === opt.slug;
            return (
              <button
                key={opt.slug}
                onClick={() => onGuidanceLevelChange(opt.slug)}
                disabled={busy}
                aria-pressed={active}
                title={opt.blurb}
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: active ? 'var(--arcane)' : 'var(--bg-card)',
                  color: active ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (active ? 'var(--arcane)' : 'var(--border)'),
                  cursor: busy ? 'wait' : 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  display: 'inline-flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  minWidth: 140,
                }}
              >
                <span>{opt.label}</span>
                <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{opt.blurb}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Difficulty numbers</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            When ON, the master shows DC and AC values in narration (e.g. &ldquo;DC 12 Insight check&rdquo;). When OFF, those numbers stay hidden — the master uses qualitative language and adjudicates privately. More immersive: you roll without knowing exactly how hard the check is.
          </p>
        </div>
        <button
          onClick={onShowDifficultyNumbersToggle}
          disabled={busy}
          aria-pressed={prefs.showDifficultyNumbers}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            height: 36,
            padding: '0 14px',
            background: prefs.showDifficultyNumbers ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (prefs.showDifficultyNumbers ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999,
            color: prefs.showDifficultyNumbers ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          <Icon name="dice" size={14} />
          {prefs.showDifficultyNumbers ? 'DC/AC visible' : 'DC/AC hidden'}
        </button>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Scene illustrations</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Scene images</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            When enabled, every master message gets an &ldquo;Image&rdquo; button next to the &ldquo;Listen&rdquo; one. Click it to illustrate that scene — generation takes ~10-30s, uses your OpenAI API budget, and the result appears in the Scene panel on the right.
          </p>
        </div>
        <button
          onClick={onImageGenToggle}
          disabled={busy}
          aria-pressed={prefs.imageGenerationEnabled}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: prefs.imageGenerationEnabled ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (prefs.imageGenerationEnabled ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999,
            color: prefs.imageGenerationEnabled ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          <Icon name="sparkle" size={14} />
          {prefs.imageGenerationEnabled ? 'Generation on' : 'Generation off'}
        </button>

        {prefs.imageGenerationEnabled && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>
                Provider
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['openai', 'gemini'] as ImageProviderName[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => onImageProviderChange(p)}
                    disabled={busy}
                    aria-pressed={prefs.imageProvider === p}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 999,
                      background: prefs.imageProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                      color: prefs.imageProvider === p ? 'var(--bone)' : 'var(--fg)',
                      border: '1px solid ' + (prefs.imageProvider === p ? 'var(--arcane)' : 'var(--border)'),
                      cursor: busy ? 'wait' : 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {p === 'openai' ? 'OpenAI' : 'Gemini'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label htmlFor="imageModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>
                Model
              </label>
              <select
                id="imageModel"
                value={prefs.imageModel}
                onChange={onImageModelChange}
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
                {imageModelsForProvider(prefs.imageProvider).map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}
                  </option>
                ))}
              </select>
            </div>

            <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Image style</label>
            <select
              value={prefs.imageStylePreset}
              onChange={onImageStylePresetChange}
              disabled={busy}
              style={{
                height: 36, padding: '0 10px', borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-card)', color: 'var(--fg)',
                fontFamily: 'var(--font-ui)', fontSize: 13,
              }}
            >
              <option value="pastel">Pastel drawing (default)</option>
              <option value="watercolor">Watercolor</option>
              <option value="oil">Oil painting</option>
              <option value="ink">Ink illustration</option>
              <option value="photo">Cinematic photo</option>
              <option value="custom">Custom…</option>
            </select>

            {prefs.imageStylePreset === 'custom' && (
              <textarea
                value={prefs.imageStyleCustom ?? ''}
                onChange={onImageStyleCustomChange}
                onBlur={onImageStyleCustomBlur}
                placeholder="e.g. retro pixel art, low-poly 3d render, pen-and-ink with watercolor washes…"
                rows={2}
                maxLength={500}
                style={{
                  padding: 10, borderRadius: 6,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-card)', color: 'var(--fg)',
                  fontFamily: 'var(--font-ui)', fontSize: 13, resize: 'vertical',
                }}
              />
            )}
          </div>
        )}
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
