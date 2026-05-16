'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import { RebuildMemoryButton } from '@/components/rebuild-memory-button';
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
import type { LocalServicesStatus, ModelOption as LocalModelOption } from '@/lib/local-services';

export interface CampaignSettingsClientProps {
  campaignId: string;
  initialSettings: Required<CampaignSettings>;
  initialLanguage: string | null;
  canEdit: boolean;
  activeSessionId: string | null;
  localServices: LocalServicesStatus;
  /** When set, the page renders a first-run banner + "Start campaign" CTA
   *  that navigates to /sessions/{firstRunSessionId}. Used by the
   *  /campaigns/new wizard which detours through here so the player can
   *  tune provider/model before the first turn. */
  firstRunSessionId?: string | null;
}

const CAMPAIGN_LANGUAGES: { code: string; label: string }[] = [
  { code: '',   label: 'Auto-detect (from first player message)' },
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
];

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
  local: 'Local',
};

export function CampaignSettingsClient({ campaignId, initialSettings, initialLanguage, canEdit, activeSessionId, localServices, firstRunSessionId }: CampaignSettingsClientProps) {
  const [settings, setSettings] = React.useState<Required<CampaignSettings>>(initialSettings);
  const [language, setLanguage] = React.useState<string>(initialLanguage ?? '');
  const [busy, setBusy] = React.useState(false);
  const [savedOnce, setSavedOnce] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async (patch: Partial<CampaignSettings> & { language?: string | null }): Promise<void> => {
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
      const { settings: next, language: nextLanguage } = (await res.json()) as { settings: Required<CampaignSettings>; language?: string | null };
      setSettings(next);
      if (nextLanguage !== undefined) setLanguage(nextLanguage ?? '');
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
    if (next === 'local') {
      // Pick first enabled engine, then its first available voice.
      const engine = localServices.tts.engines.piper.enabled ? 'piper' : 'xtts';
      const engineModels = engine === 'piper'
        ? localServices.tts.engines.piper.models
        : localServices.tts.engines.xtts.models;
      const nextVoice = engineModels[0]?.slug ?? (engine === 'xtts' ? 'en' : '');
      setSettings((s) => ({ ...s, ttsProvider: 'local', ttsModel: engine, ttsVoice: nextVoice }));
      void save({ ttsProvider: 'local', ttsModel: engine, ttsVoice: nextVoice });
      return;
    }
    const nextModel = ttsDefaultModelFor(next);
    const nextVoice = ttsDefaultVoiceForModel(next, nextModel);
    setSettings((s) => ({ ...s, ttsProvider: next, ttsVoice: nextVoice, ttsModel: nextModel }));
    void save({ ttsProvider: next, ttsVoice: nextVoice, ttsModel: nextModel });
  };

  /** Local-mode engine selector for TTS (Piper / XTTSv2). Resets voice to the
   *  first available slug for the new engine. */
  const onTtsLocalEngineChange = (engine: 'piper' | 'xtts'): void => {
    const engineStatus = engine === 'piper' ? localServices.tts.engines.piper : localServices.tts.engines.xtts;
    const nextVoice = engineStatus.models[0]?.slug ?? (engine === 'xtts' ? 'en' : '');
    setSettings((s) => ({ ...s, ttsModel: engine, ttsVoice: nextVoice }));
    void save({ ttsModel: engine, ttsVoice: nextVoice });
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

  const onCompactPromptToggle = (): void => {
    const next = !settings.compactPrompt;
    setSettings((s) => ({ ...s, compactPrompt: next }));
    void save({ compactPrompt: next });
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
    if (next === 'local') {
      const engine = localServices.image.engines.comfyui.enabled ? 'comfyui' : 'drawThings';
      const list = engine === 'comfyui'
        ? localServices.image.engines.comfyui.models
        : localServices.image.engines.drawThings.models;
      const nextModel = list[0]?.slug ?? (engine === 'comfyui' ? 'comfyui:flux-schnell' : '');
      setSettings((s) => ({ ...s, imageProvider: 'local', imageModel: nextModel }));
      void save({ imageProvider: 'local', imageModel: nextModel });
      return;
    }
    const nextModel = defaultImageModelForProvider(next);
    setSettings((s) => ({ ...s, imageProvider: next, imageModel: nextModel }));
    void save({ imageProvider: next, imageModel: nextModel });
  };

  /** Local-mode engine selector for image (ComfyUI / Draw Things). Resets the
   *  model slug to the first available checkpoint/workflow for the new engine. */
  const onImageLocalEngineChange = (engine: 'comfyui' | 'drawThings'): void => {
    const list = engine === 'comfyui'
      ? localServices.image.engines.comfyui.models
      : localServices.image.engines.drawThings.models;
    const nextModel = list[0]?.slug ?? (engine === 'comfyui' ? 'comfyui:flux-schnell' : '');
    setSettings((s) => ({ ...s, imageModel: nextModel }));
    void save({ imageModel: nextModel });
  };

  const onImageModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setSettings((s) => ({ ...s, imageModel: slug }));
    void save({ imageModel: slug });
  };

  const onProviderChange = (next: ProviderName): void => {
    if (next === settings.aiProvider) return;
    if (next === 'local') {
      const firstModel = localServices.ai.models[0]?.slug ?? '';
      setSettings((s) => ({ ...s, aiProvider: 'local', aiMasterModel: firstModel }));
      void save({ aiProvider: 'local', aiMasterModel: firstModel });
      return;
    }
    const nextModel = defaultModelForProvider(next);
    setSettings((s) => ({ ...s, aiProvider: next, aiMasterModel: nextModel }));
    void save({ aiProvider: next, aiMasterModel: nextModel });
  };

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setSettings((s) => ({ ...s, aiMasterModel: slug }));
    void save({ aiMasterModel: slug });
  };

  const onLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value;  // '' for auto-detect, else 2-letter code
    setLanguage(next);
    // Send null to the API when blank — explicit reset to auto-detect.
    void save({ language: next === '' ? null : next });
  };

  // For provider='local' the runtime list of Ollama models comes from the
  // server-side fetch passed through localServices.ai.models.
  const availableModels: (LocalModelOption | { slug: string; label: string; blurb: string; recommended?: boolean })[] =
    settings.aiProvider === 'local'
      ? localServices.ai.models
      : modelsForProvider(settings.aiProvider as Exclude<ProviderName, 'local'>);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 36, fontWeight: 600 }}>
            {firstRunSessionId ? 'Tune your campaign' : 'Campaign settings'}
          </h1>
          <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            {firstRunSessionId
              ? 'Pick provider, model, voice and style before the first turn — you can change them any time.'
              : 'Tune the Master’s voice and how it behaves at this campaign’s table.'}
          </p>
        </div>
        {!firstRunSessionId && (
          <Link href={`/campaigns/${campaignId}`}>
            <Button variant="ghost" size="md" icon="arrow-left">Back to campaign</Button>
          </Link>
        )}
      </div>

      {firstRunSessionId && (
        <>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="sparkle" size={16} />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--fg)' }}>
                Welcome! Settings autosave as you change them. When you&apos;re ready, hit <strong>Start campaign</strong> at the bottom.
              </p>
            </div>
          </Card>
          <div style={{ height: 16 }} />
        </>
      )}

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
            {((localServices.isLocal && localServices.ai.enabled
              ? ['anthropic', 'openai', 'gemini', 'local']
              : ['anthropic', 'openai', 'gemini']) as ProviderName[]).map((p) => (
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
                {p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Gemini' : 'Local'}
              </button>
            ))}
          </div>
        </div>

        {settings.aiProvider === 'local' && (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 70 }}>
            {localServices.ai.reachable
              ? `✓ Ollama @ ${process.env.NEXT_PUBLIC_OLLAMA_LABEL ?? 'localhost'}`
              : `✗ Ollama ${localServices.ai.error ?? 'unreachable'}`}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="masterModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Model</label>
          <select id="masterModel" value={settings.aiMasterModel} onChange={onModelChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {(() => {
              if (availableModels.length === 0 && settings.aiProvider === 'local') {
                return (
                  <option disabled value="">{localServices.ai.reachable ? 'No qwen3/gpt-oss installed in Ollama' : 'Ollama unreachable'}</option>
                );
              }
              // Plan D: when local, split baked (dnd-master-*) from raw bases
              // so users immediately see the optimised variants at the top.
              if (settings.aiProvider === 'local') {
                const baked = availableModels.filter((m) => 'kind' in m && m.kind === 'baked');
                const raw = availableModels.filter((m) => !('kind' in m) || m.kind !== 'baked');
                return (
                  <>
                    {baked.length > 0 && (
                      <optgroup label="Optimized (built locally)">
                        {baked.map((m) => (
                          <option key={m.slug} value={m.slug}>{m.label} — {m.blurb}</option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label={baked.length > 0 ? 'Base models (slower)' : 'Installed models'}>
                      {raw.map((m) => (
                        <option key={m.slug} value={m.slug}>
                          {m.label}{'recommended' in m && (m as { recommended?: boolean }).recommended ? ' (recommended)' : ''} — {m.blurb}
                        </option>
                      ))}
                    </optgroup>
                  </>
                );
              }
              // Cloud providers: flat list as before.
              return availableModels.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.label}{'recommended' in m && (m as { recommended?: boolean }).recommended ? ' (recommended)' : ''} — {m.blurb}
                </option>
              ));
            })()}
          </select>
        </div>

        {settings.aiProvider === 'local'
          && localServices.ai.reachable
          && availableModels.length > 0
          && availableModels.every((m) => !('kind' in m) || m.kind !== 'baked') && (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 70 }}>
            💡 Run <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elev)', padding: '0 4px', borderRadius: 3 }}>pnpm build-local-models</code> in your terminal to enable optimized variants (~30s build, much faster turns).
          </div>
        )}
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Language</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Campaign language</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Lingua usata dal master per narrare. &ldquo;Auto-detect&rdquo; lascia che il master la deduca dal primo messaggio del giocatore.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="campaignLanguage" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Language</label>
          <select id="campaignLanguage" value={language} onChange={onLanguageChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {CAMPAIGN_LANGUAGES.map((l) => (
              <option key={l.code || 'auto'} value={l.code}>{l.label}</option>
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
            {TTS_PROVIDERS.filter((p) => p !== 'local' || (localServices.isLocal && localServices.tts.enabled)).map((p) => (
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

        {settings.ttsProvider === 'local' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Engine</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['piper', 'xtts'] as const).map((eng) => {
                  const engStatus = eng === 'piper' ? localServices.tts.engines.piper : localServices.tts.engines.xtts;
                  return (
                    <button
                      key={eng}
                      onClick={() => onTtsLocalEngineChange(eng)}
                      disabled={disabled || !engStatus.enabled}
                      aria-pressed={settings.ttsModel === eng}
                      title={!engStatus.enabled ? `${eng.toUpperCase()}_BASE_URL not set` : undefined}
                      style={{ padding: '8px 16px', borderRadius: 999,
                        background: settings.ttsModel === eng ? 'var(--arcane)' : 'var(--bg-card)',
                        color: settings.ttsModel === eng ? 'var(--bone)' : 'var(--fg)',
                        border: '1px solid ' + (settings.ttsModel === eng ? 'var(--arcane)' : 'var(--border)'),
                        cursor: (disabled || !engStatus.enabled) ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                        opacity: !engStatus.enabled ? 0.4 : (!canEdit ? 0.7 : 1) }}>
                      {eng === 'piper' ? 'Piper' : 'XTTSv2'}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 70 }}>
              {localServices.tts.engines.piper.enabled && (
                <span style={{ marginRight: 8 }}>
                  {localServices.tts.engines.piper.reachable ? '✓ Piper' : `✗ Piper (${localServices.tts.engines.piper.error ?? 'down'})`}
                </span>
              )}
              {localServices.tts.engines.xtts.enabled && (
                <span>
                  {localServices.tts.engines.xtts.reachable ? '✓ XTTSv2' : `✗ XTTSv2 (${localServices.tts.engines.xtts.error ?? 'down'})`}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label htmlFor="ttsVoice" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Voice</label>
              <select id="ttsVoice" value={settings.ttsVoice} onChange={onVoiceChange} disabled={disabled}
                style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
                {(() => {
                  const list = settings.ttsModel === 'piper'
                    ? localServices.tts.engines.piper.models
                    : localServices.tts.engines.xtts.models;
                  if (list.length === 0) {
                    return <option disabled value="">{settings.ttsModel === 'piper' ? 'Piper unreachable — no voices listed' : 'No XTTS languages'}</option>;
                  }
                  return list.map((v) => <option key={v.slug} value={v.slug}>{v.label}</option>);
                })()}
              </select>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
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

      {settings.aiProvider === 'local' && (
        <>
          <div style={{ height: 16 }} />
          <Card>
            <div>
              <Eyebrow>Local optimization</Eyebrow>
              <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Compact prompt</h2>
              <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
                Trims the master&apos;s system prompt (handbook, world lore, SRD reference) to imperative cheat-sheets — about
                30 KB lighter. Small local models (qwen3:14b, gpt-oss:20b) answer noticeably faster but narration is simpler.
                Default ON for local, OFF for cloud.
              </p>
              {settings.aiMasterModel.startsWith('dnd-master-') && (
                <p style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)', fontStyle: 'italic' }}>
                  Has no effect when using an optimized (<code>dnd-master-*</code>) model — the full handbook is baked into the model weights, so compact vs full is identical at runtime.
                </p>
              )}
            </div>
            <button onClick={onCompactPromptToggle} disabled={disabled || settings.aiMasterModel.startsWith('dnd-master-')} aria-pressed={settings.compactPrompt}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
                background: settings.compactPrompt ? 'var(--arcane)' : 'transparent',
                border: '1px solid ' + (settings.compactPrompt ? 'var(--arcane)' : 'var(--border-strong)'),
                borderRadius: 999, color: settings.compactPrompt ? 'var(--bone)' : 'var(--fg-muted)',
                fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
                cursor: (disabled || settings.aiMasterModel.startsWith('dnd-master-')) ? 'not-allowed' : 'pointer',
                opacity: (!canEdit || settings.aiMasterModel.startsWith('dnd-master-')) ? 0.5 : 1 }}>
              <Icon name="sparkle" size={14} />
              {settings.compactPrompt ? 'Compact prompt on' : 'Compact prompt off'}
            </button>
          </Card>
        </>
      )}

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
                {((localServices.isLocal && localServices.image.enabled
                  ? ['openai', 'gemini', 'local']
                  : ['openai', 'gemini']) as ImageProviderName[]).map((p) => (
                  <button key={p} onClick={() => onImageProviderChange(p)} disabled={disabled} aria-pressed={settings.imageProvider === p}
                    style={{ padding: '8px 16px', borderRadius: 999,
                      background: settings.imageProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                      color: settings.imageProvider === p ? 'var(--bone)' : 'var(--fg)',
                      border: '1px solid ' + (settings.imageProvider === p ? 'var(--arcane)' : 'var(--border)'),
                      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                      opacity: !canEdit ? 0.7 : 1 }}>
                    {p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Gemini' : 'Local'}
                  </button>
                ))}
              </div>
            </div>

            {settings.imageProvider === 'local' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Engine</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['comfyui', 'drawThings'] as const).map((eng) => {
                      const engStatus = eng === 'comfyui' ? localServices.image.engines.comfyui : localServices.image.engines.drawThings;
                      const isActive = eng === 'comfyui'
                        ? settings.imageModel?.startsWith('comfyui:')
                        : settings.imageModel?.startsWith('draw-things:');
                      const envName = eng === 'comfyui' ? 'COMFYUI_BASE_URL' : 'DRAW_THINGS_BASE_URL';
                      return (
                        <button
                          key={eng}
                          onClick={() => onImageLocalEngineChange(eng)}
                          disabled={disabled || !engStatus.enabled}
                          aria-pressed={isActive}
                          title={!engStatus.enabled ? `${envName} not set` : undefined}
                          style={{ padding: '8px 16px', borderRadius: 999,
                            background: isActive ? 'var(--arcane)' : 'var(--bg-card)',
                            color: isActive ? 'var(--bone)' : 'var(--fg)',
                            border: '1px solid ' + (isActive ? 'var(--arcane)' : 'var(--border)'),
                            cursor: (disabled || !engStatus.enabled) ? 'not-allowed' : 'pointer',
                            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                            opacity: !engStatus.enabled ? 0.4 : (!canEdit ? 0.7 : 1) }}>
                          {eng === 'comfyui' ? 'ComfyUI' : 'Draw Things'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 90 }}>
                  {localServices.image.engines.comfyui.enabled && (
                    <span style={{ marginRight: 8 }}>
                      {localServices.image.engines.comfyui.reachable ? '✓ ComfyUI' : `✗ ComfyUI (${localServices.image.engines.comfyui.error ?? 'down'})`}
                    </span>
                  )}
                  {localServices.image.engines.drawThings.enabled && (
                    <span>
                      {localServices.image.engines.drawThings.reachable ? '✓ Draw Things' : `✗ Draw Things (${localServices.image.engines.drawThings.error ?? 'down'})`}
                    </span>
                  )}
                </div>
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label htmlFor="imageModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Model</label>
              <select id="imageModel" value={settings.imageModel} onChange={onImageModelChange} disabled={disabled}
                style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
                {settings.imageProvider === 'local' ? (() => {
                  const engine = settings.imageModel?.startsWith('comfyui:') ? 'comfyui' :
                                 settings.imageModel?.startsWith('draw-things:') ? 'drawThings' : 'comfyui';
                  const list = engine === 'comfyui' ? localServices.image.engines.comfyui.models : localServices.image.engines.drawThings.models;
                  if (list.length === 0) {
                    return <option disabled value="">{engine === 'comfyui' ? 'No ComfyUI workflows' : 'Draw Things unreachable — no checkpoints'}</option>;
                  }
                  return list.map((m) => <option key={m.slug} value={m.slug}>{m.label} — {m.blurb}</option>);
                })() : (
                  imageModelsForProvider(settings.imageProvider as Exclude<ImageProviderName, 'local'>).map((m) => (
                    <option key={m.slug} value={m.slug}>{m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}</option>
                  ))
                )}
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

      {!firstRunSessionId && (
        <>
          <div style={{ height: 16 }} />

          <Card>
            <div>
              <Eyebrow>Maintenance</Eyebrow>
              <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Memoria</h2>
              <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
                Rigenera il codex della sessione attiva da zero. Utile se un crash a metà turno ha lasciato l&apos;estrattore di memoria in uno stato incoerente.
              </p>
            </div>
            {activeSessionId ? (
              <RebuildMemoryButton sessionId={activeSessionId} />
            ) : (
              <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>
                Nessuna sessione attiva per questa campagna.
              </p>
            )}
          </Card>
        </>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', minHeight: 18 }}>
        {error ? <span style={{ color: 'var(--ember)' }}>Save failed: {error}</span>
          : busy ? <span>Saving…</span>
          : savedOnce ? <span>Saved.</span> : null}
      </div>

      {firstRunSessionId && (
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <Link href={`/campaigns/${campaignId}`}>
            <Button variant="ghost" size="md">Cancel</Button>
          </Link>
          <Link href={`/sessions/${firstRunSessionId}`}>
            <Button variant="primary" size="lg" icon="sparkle">Start campaign</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
