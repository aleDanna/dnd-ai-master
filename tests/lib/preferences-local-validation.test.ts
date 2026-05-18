import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateSettingsPatch } from '@/lib/preferences';

describe('validateSettingsPatch — local provider gating', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('PIPER_BASE_URL', '');
    vi.stubEnv('COMFYUI_BASE_URL', '');
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts aiProvider=local when local env + OLLAMA_BASE_URL set', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const r = validateSettingsPatch({ aiProvider: 'local' });
    expect(r.ok).toBe(true);
  });

  it('rejects aiProvider=local when OLLAMA_BASE_URL unset', () => {
    const r = validateSettingsPatch({ aiProvider: 'local' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid-aiProvider');
  });

  it('rejects aiProvider=local when not local environment', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const r = validateSettingsPatch({ aiProvider: 'local' });
    expect(r.ok).toBe(false);
  });

  it('accepts aiMasterModel for local (any non-empty string ≤200)', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' });
    expect(r.ok).toBe(true);
  });

  it('rejects aiMasterModel for local when over 200 chars', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: 'x'.repeat(201) });
    expect(r.ok).toBe(false);
  });

  it('accepts ttsProvider=local + ttsModel=piper when PIPER set', () => {
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
    const r = validateSettingsPatch({ ttsProvider: 'local', ttsModel: 'piper', ttsVoice: 'en_US-amy-low' });
    expect(r.ok).toBe(true);
  });

  it('rejects ttsModel=piper when PIPER_BASE_URL unset', () => {
    const r = validateSettingsPatch({ ttsProvider: 'local', ttsModel: 'piper', ttsVoice: 'en_US-amy-low' });
    expect(r.ok).toBe(false);
  });

  it('accepts imageProvider=local + imageModel=comfyui:flux-schnell when COMFYUI set', () => {
    vi.stubEnv('COMFYUI_BASE_URL', 'http://localhost:8188');
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'comfyui:flux-schnell' });
    expect(r.ok).toBe(true);
  });

  it('rejects imageModel=comfyui:* when COMFYUI_BASE_URL unset', () => {
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'comfyui:flux-schnell' });
    expect(r.ok).toBe(false);
  });

  it('accepts imageProvider=local + imageModel=draw-things:* when DRAW_THINGS set', () => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'draw-things:realisticVisionV60' });
    expect(r.ok).toBe(true);
  });
});

describe('validateSettingsPatch — compactPrompt (Plan C)', () => {
  it('accepts compactPrompt=true', () => {
    const r = validateSettingsPatch({ compactPrompt: true });
    if (!r.ok) throw new Error(`unexpected error: ${r.error}`);
    expect(r.patch.compactPrompt).toBe(true);
  });

  it('accepts compactPrompt=false', () => {
    const r = validateSettingsPatch({ compactPrompt: false });
    if (!r.ok) throw new Error(`unexpected error: ${r.error}`);
    expect(r.patch.compactPrompt).toBe(false);
  });

  it('rejects non-boolean compactPrompt', () => {
    const r = validateSettingsPatch({ compactPrompt: 'yes' as unknown as boolean });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected validation failure');
    expect(r.error).toBe('invalid-compactPrompt');
  });

  it('rejects numeric compactPrompt', () => {
    const r = validateSettingsPatch({ compactPrompt: 1 as unknown as boolean });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected validation failure');
    expect(r.error).toBe('invalid-compactPrompt');
  });
});
