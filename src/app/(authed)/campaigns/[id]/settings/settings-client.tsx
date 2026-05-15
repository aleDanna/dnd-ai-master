'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import {
  TTS_PROVIDERS,
  type TtsProvider,
  voicesForModel as ttsVoicesForModel,
  modelsForProvider as ttsModelsFor,
  defaultVoiceForModel as ttsDefaultVoiceForModel,
  defaultModelForProvider as ttsDefaultModelFor,
  isValidTtsProvider,
} from '@/lib/tts-voices';
import {
  modelsForProvider,
  defaultModelForProvider,
  imageModelsForProvider,
  defaultImageModelForProvider,
  type ProviderName,
  type ImageProviderName,
} from '@/lib/ai-models';
import type { CampaignSettings } from '@/db/schema/campaigns';

export interface CampaignSettingsClientProps {
  campaignId: string;
  initialSettings: Required<CampaignSettings>;
  canEdit: boolean;
}

const TTS_MODEL_BLURBS: Record<string, string> = {
  'gpt-4o-mini-tts': 'Newer, voice-steering supported',
  'tts-1': 'Lower latency, slightly less natural',
  'tts-1-hd': 'Higher fidelity, slower & pricier',
  'gemini-2.5-flash-preview-tts': 'Faster, cheaper',
  'gemini-2.5-pro-preview-tts': 'Higher fidelity, slower',
};

const TTS_PROVIDER_LABELS: Record<TtsProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
};

export function CampaignSettingsClient({ campaignId, initialSettings, canEdit }: CampaignSettingsClientProps) {
  const [settings, setSettings] = React.useState<Required<CampaignSettings>>(initialSettings);
  const [busy, setBusy] = React.useState(false);
  const [savedOnce, setSavedOnce] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async (patch: Partial<CampaignSettings>): Promise<void> => {
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { settings: next } = (await res.json()) as { settings: Required<CampaignSettings> };
      setSettings(next);
      setSavedOnce(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const disabled = !canEdit || busy;

  const onVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const value = e.target.value;
    setSettings((s) => ({ ...s, ttsVoice: value }));
    void save({ ttsVoice: value });
  };

  const onTtsModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const nextModel = e.target.value;
    const allowedVoices = ttsVoicesForModel(settings.ttsProvider, nextModel);
    const keepVoice = allowedVoices.includes(settings.ttsVoice);
    const nextVoice = keepVoice ? settings.ttsVoice : ttsDefaultVoiceForModel(settings.ttsProvider, nextModel);
    setSettings((s) => ({ ...s, ttsModel: nextModel, ttsVoice: nextVoice }));
    void save(keepVoice ? { ttsModel: nextModel } : { ttsModel: nextModel, ttsVoice: nextVoice });
  };

  const onTtsProviderChange = (next: TtsProvider): void => {
    if (!isValidTtsProvider(next) || next === settings.ttsProvider) return;
    const nextModel = ttsDefaultModelFor(next);
    const nextVoice = ttsDefaultVoiceForModel(next, nextModel);
    setSettings((s) => ({ ...s, ttsProvider: next, ttsVoice: nextVoice, ttsModel: nextModel }));
    void save({ ttsProvider: next, ttsVoice: nextVoice, ttsModel: nextModel });
  };

  const onManualRollsToggle = (): void => {
    const next = !settings.manualRolls;
    setSettings((s) => ({ ...s, manualRolls: next }));
    void save({ manualRolls: next });
  };

  const onGuidanceLevelChange = (next: 'free' | 'balanced' | 'structured'): void => {
    if (next === settings.masterGuidanceLevel) return;
    setSettings((s) => ({ ...s, masterGuidanceLevel: next }));
    void save({ masterGuidanceLevel: next });
  };

  const onShowDifficultyNumbersToggle = (): void => {
    const next = !settings.showDifficultyNumbers;
    setSettings((s) => ({ ...s, showDifficultyNumbers: next }));
    void save({ showDifficultyNumbers: next });
  };

  const onNarrationPaceChange = (next: 'detailed' | 'brisk'): void => {
    if (next === settings.narrationPace) return;
    setSettings((s) => ({ ...s, narrationPace: next }));
    void save({ narrationPace: next });
  };

  const onImageGenToggle = (): void => {
    const next = !settings.imageGenerationEnabled;
    setSettings((s) => ({ ...s, imageGenerationEnabled: next }));
    void save({ imageGenerationEnabled: next });
  };

  const onImageStylePresetChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value as NonNullable<CampaignSettings['imageStylePreset']>;
    if (next === settings.imageStylePreset) return;
    setSettings((s) => ({ ...s, imageStylePreset: next }));
    void save({ imageStylePreset: next });
  };

  const onImageStyleCustomChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value;
    setSettings((s) => ({ ...s, imageStyleCustom: next }));
  };
  const onImageStyleCustomBlur = (): void => {
    void save({ imageStyleCustom: settings.imageStyleCustom });
  };

  const onImageProviderChange = (next: ImageProviderName): void => {
    if (next === settings.imageProvider) return;
    const nextModel = defaultImageModelForProvider(next);
    setSettings((s) => ({ ...s, imageProvider: next, imageModel: nextModel }));
    void save({ imageProvider: next, imageModel: nextModel });
  };

  const onImageModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setSettings((s) => ({ ...s, imageModel: slug }));
    void save({ imageModel: slug });
  };

  const onProviderChange = (next: ProviderName): void => {
    if (next === settings.aiProvider) return;
    const nextModel = defaultModelForProvider(next);
    setSettings((s) => ({ ...s, aiProvider: next, aiMasterModel: nextModel }));
    void save({ aiProvider: next, aiMasterModel: nextModel });
  };

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setSettings((s) => ({ ...s, aiMasterModel: slug }));
    void save({ aiMasterModel: slug });
  };

  const availableModels = modelsForProvider(settings.aiProvider);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 36, fontWeight: 600 }}>Campaign settings</h1>
          <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            Tune the Master&apos;s voice and how it behaves at this campaign&apos;s table.
          </p>
        </div>
        <Link href={`/campaigns/${campaignId}`}>
          <Button variant="ghost" size="md" icon="arrow-left">Back to campaign</Button>
        </Link>
      </div>

      {!canEdit && (
        <>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="settings" size={16} />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)' }}>
                Solo il creatore della campagna può modificare queste impostazioni.
              </p>
            </div>
          </Card>
          <div style={{ height: 16 }} />
        </>
      )}

      <Card>
        <div>
          <Eyebrow>AI master</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Provider &amp; model</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Drives the master narration. Shared with every player in the campaign.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="provider" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>
            Provider
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['anthropic', 'openai', 'gemini'] as ProviderName[]).map((p) => (
              <button
                key={p}
                onClick={() => onProviderChange(p)}
                disabled={disabled}
                aria-pressed={settings.aiProvider === p}
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: settings.aiProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                  color: settings.aiProvider === p ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (settings.aiProvider === p ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  opacity: !canEdit ? 0.7 : 1,
                }}
              >
                {p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : 'Gemini'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="masterModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Model</label>
          <select id="masterModel" value={settings.aiMasterModel} onChange={onModelChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {availableModels.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Voice</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Master voice (TTS)</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            The narration voice every player hears. Switching invalidates cached audio for past messages; they re-synthesize on the next click.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Provider</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {TTS_PROVIDERS.map((p) => (
              <button key={p} onClick={() => onTtsProviderChange(p)} disabled={disabled} aria-pressed={settings.ttsProvider === p}
                style={{ padding: '8px 16px', borderRadius: 999,
                  background: settings.ttsProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                  color: settings.ttsProvider === p ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (settings.ttsProvider === p ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  opacity: !canEdit ? 0.7 : 1 }}>
                {TTS_PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Model</label>
          <select id="ttsModel" value={settings.ttsModel} onChange={onTtsModelChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {ttsModelsFor(settings.ttsProvider).map((m) => (
              <option key={m} value={m}>{m}{TTS_MODEL_BLURBS[m] ? ` — ${TTS_MODEL_BLURBS[m]}` : ''}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsVoice" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Voice</label>
          <select id="ttsVoice" value={settings.ttsVoice} onChange={onVoiceChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {ttsVoicesForModel(settings.ttsProvider, settings.ttsModel).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Dice rolls</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Auto-roll: the AI computes attacks, saves and damage server-side. Manual: the master writes the formula and the app shows a roll button — the result is sent back automatically.
          </p>
        </div>
        <button onClick={onManualRollsToggle} disabled={disabled} aria-pressed={settings.manualRolls}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: settings.manualRolls ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (settings.manualRolls ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999, color: settings.manualRolls ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: !canEdit ? 0.7 : 1 }}>
          <Icon name="dice" size={14} />
          {settings.manualRolls ? 'Manual rolls' : 'Auto-rolls'}
        </button>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Master guidance</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>How proactively the master suggests possible actions.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            { slug: 'free' as const, label: 'Free', blurb: 'Pure narration, open prompt' },
            { slug: 'balanced' as const, label: 'Balanced', blurb: 'Hints in prose, no list' },
            { slug: 'structured' as const, label: 'Structured', blurb: 'Numbered choice list' },
          ]).map((opt) => {
            const active = settings.masterGuidanceLevel === opt.slug;
            return (
              <button key={opt.slug} onClick={() => onGuidanceLevelChange(opt.slug)} disabled={disabled} aria-pressed={active} title={opt.blurb}
                style={{ padding: '8px 16px', borderRadius: 999,
                  background: active ? 'var(--arcane)' : 'var(--bg-card)',
                  color: active ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (active ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 140,
                  opacity: !canEdit ? 0.7 : 1 }}>
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
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Narration pace</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Detailed: every micro-beat is its own master turn. Brisk: the master collapses obvious follow-through into one beat.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            { slug: 'detailed' as const, label: 'Detailed', blurb: 'Every micro-beat' },
            { slug: 'brisk' as const, label: 'Brisk', blurb: 'Collapse filler beats' },
          ]).map((opt) => {
            const active = (settings.narrationPace ?? 'detailed') === opt.slug;
            return (
              <button key={opt.slug} onClick={() => onNarrationPaceChange(opt.slug)} disabled={disabled} aria-pressed={active} title={opt.blurb}
                style={{ padding: '8px 16px', borderRadius: 999,
                  background: active ? 'var(--arcane)' : 'var(--bg-card)',
                  color: active ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (active ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 140,
                  opacity: !canEdit ? 0.7 : 1 }}>
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
            When ON, the master shows DC and AC values in narration. When OFF, those numbers stay hidden.
          </p>
        </div>
        <button onClick={onShowDifficultyNumbersToggle} disabled={disabled} aria-pressed={settings.showDifficultyNumbers}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: settings.showDifficultyNumbers ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (settings.showDifficultyNumbers ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999, color: settings.showDifficultyNumbers ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: !canEdit ? 0.7 : 1 }}>
          <Icon name="dice" size={14} />
          {settings.showDifficultyNumbers ? 'DC/AC visible' : 'DC/AC hidden'}
        </button>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Scene illustrations</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Scene images</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            When enabled, every master message gets an &ldquo;Image&rdquo; button to illustrate that scene.
          </p>
        </div>
        <button onClick={onImageGenToggle} disabled={disabled} aria-pressed={settings.imageGenerationEnabled}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: settings.imageGenerationEnabled ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (settings.imageGenerationEnabled ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999, color: settings.imageGenerationEnabled ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: !canEdit ? 0.7 : 1 }}>
          <Icon name="sparkle" size={14} />
          {settings.imageGenerationEnabled ? 'Generation on' : 'Generation off'}
        </button>

        {settings.imageGenerationEnabled && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Provider</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['openai', 'gemini'] as ImageProviderName[]).map((p) => (
                  <button key={p} onClick={() => onImageProviderChange(p)} disabled={disabled} aria-pressed={settings.imageProvider === p}
                    style={{ padding: '8px 16px', borderRadius: 999,
                      background: settings.imageProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                      color: settings.imageProvider === p ? 'var(--bone)' : 'var(--fg)',
                      border: '1px solid ' + (settings.imageProvider === p ? 'var(--arcane)' : 'var(--border)'),
                      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                      opacity: !canEdit ? 0.7 : 1 }}>
                    {p === 'openai' ? 'OpenAI' : 'Gemini'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label htmlFor="imageModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Model</label>
              <select id="imageModel" value={settings.imageModel} onChange={onImageModelChange} disabled={disabled}
                style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
                {imageModelsForProvider(settings.imageProvider).map((m) => (
                  <option key={m.slug} value={m.slug}>{m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}</option>
                ))}
              </select>
            </div>

            <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Image style</label>
            <select value={settings.imageStylePreset} onChange={onImageStylePresetChange} disabled={disabled}
              style={{ height: 36, padding: '0 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              <option value="pastel">Pastel drawing (default)</option>
              <option value="watercolor">Watercolor</option>
              <option value="oil">Oil painting</option>
              <option value="ink">Ink illustration</option>
              <option value="photo">Cinematic photo</option>
              <option value="custom">Custom…</option>
            </select>

            {settings.imageStylePreset === 'custom' && (
              <textarea value={settings.imageStyleCustom ?? ''} onChange={onImageStyleCustomChange} onBlur={onImageStyleCustomBlur}
                placeholder="e.g. retro pixel art, low-poly 3d render…" rows={2} maxLength={500} disabled={disabled}
                style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 13, resize: 'vertical' }} />
            )}
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', minHeight: 18 }}>
        {error ? <span style={{ color: 'var(--ember)' }}>Save failed: {error}</span>
          : busy ? <span>Saving…</span>
          : savedOnce ? <span>Saved.</span> : null}
      </div>
    </div>
  );
}
