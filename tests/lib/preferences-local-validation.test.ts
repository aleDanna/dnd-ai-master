import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateSettingsPatch, envDefaultMasterModel, sanitizeLocalMasterModel } from '@/lib/preferences';

describe('validateSettingsPatch — local provider gating', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('PIPER_BASE_URL', '');
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

  it('accepts aiMasterModel for local when in the validated family whitelist', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    for (const m of ['qwen3:30b-a3b', 'qwen3:30b-a3b-instruct-2507-q4_K_M', 'mistral-small3.2:24b', 'gpt-oss:20b']) {
      const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: m });
      expect(r.ok, m).toBe(true);
    }
  });

  it('accepts baked variants for local (Modelfile-curated)', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: 'dnd-master-plus' });
    expect(r.ok).toBe(true);
  });

  it('rejects non-validated local model families (gemma4 — the weak-tool meltdown vector)', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    for (const m of ['gemma4:latest', 'gemma4:12b', 'llama3.2:3b', 'phi3:medium']) {
      const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: m });
      expect(r.ok, m).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid-aiMasterModel');
    }
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

  it('accepts imageProvider=local + imageModel=draw-things:* when DRAW_THINGS set', () => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'draw-things:realisticVisionV60' });
    expect(r.ok).toBe(true);
  });
});

describe('envDefaultMasterModel — local default', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prefers OLLAMA_MASTER_MODEL when set', () => {
    vi.stubEnv('OLLAMA_MASTER_MODEL', 'qwen3:30b-a3b-instruct-2507');
    expect(envDefaultMasterModel('local')).toBe('qwen3:30b-a3b-instruct-2507');
  });

  it('falls back to the validated primary — never the empty string', () => {
    vi.stubEnv('OLLAMA_MASTER_MODEL', '');
    expect(envDefaultMasterModel('local')).toBe('qwen3:30b-a3b-instruct-2507-q4_K_M');
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

describe('sanitizeLocalMasterModel — turn-time enforcement (2026-06-10 live incident)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a stored non-whitelisted model (gemma4:12b-mlx) resolves to the validated default', () => {
    // The selection-time whitelist cannot fix campaigns that stored gemma
    // BEFORE it existed: the campaign screen kept showing (and the turn
    // route kept USING) gemma4:12b-mlx, which melted down on the
    // narration-only damage-roll turn (155s, empty content, 2 hallucinated
    // tool calls). Stored-but-invalid models must be overridden at READ time.
    expect(sanitizeLocalMasterModel('gemma4:12b-mlx')).toBe('qwen3:30b-a3b-instruct-2507-q4_K_M');
    expect(sanitizeLocalMasterModel('llama3.2:3b')).toBe('qwen3:30b-a3b-instruct-2507-q4_K_M');
  });

  it('whitelisted and baked models pass through unchanged', () => {
    expect(sanitizeLocalMasterModel('qwen3:30b-a3b-instruct-2507-q4_K_M')).toBe('qwen3:30b-a3b-instruct-2507-q4_K_M');
    expect(sanitizeLocalMasterModel('qwen3:30b-a3b')).toBe('qwen3:30b-a3b');
    expect(sanitizeLocalMasterModel('mistral-small3.2:24b')).toBe('mistral-small3.2:24b');
    expect(sanitizeLocalMasterModel('dnd-master-plus')).toBe('dnd-master-plus');
  });

  it('unset falls back to OLLAMA_MASTER_MODEL, then the validated primary', () => {
    expect(sanitizeLocalMasterModel(undefined)).toBe('qwen3:30b-a3b-instruct-2507-q4_K_M');
    vi.stubEnv('OLLAMA_MASTER_MODEL', 'qwen3:30b-a3b-instruct-2507');
    expect(sanitizeLocalMasterModel(undefined)).toBe('qwen3:30b-a3b-instruct-2507');
  });
});
