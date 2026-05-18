import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock db client to avoid Postgres requirement and let us swap stored prefs per test.
let TEST_PREFS: Record<string, unknown> = {};

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ preferences: TEST_PREFS }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

import { getResolvedPreferences } from '@/lib/preferences';

describe('getResolvedPreferences — local downgrade', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('PIPER_BASE_URL', '');
    vi.stubEnv('COMFYUI_BASE_URL', '');
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
    vi.stubEnv('MASTER_PROVIDER', '');
    vi.stubEnv('IMAGE_PROVIDER', '');
    vi.stubEnv('TTS_PROVIDER', '');
    TEST_PREFS = {};
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps aiProvider=local when isLocal + OLLAMA_BASE_URL set', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('local');
    expect(r.aiMasterModel).toBe('qwen3:30b-a3b');
  });

  it('downgrades aiProvider=local when not isLocalEnvironment', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
  });

  it('downgrades aiProvider=local when OLLAMA_BASE_URL unset', async () => {
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
  });

  it('keeps ttsProvider=local when isLocal + PIPER set', async () => {
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
    TEST_PREFS = { ttsProvider: 'local', ttsModel: 'piper', ttsVoice: 'en_US-amy-low' };
    const r = await getResolvedPreferences('user-id');
    expect(r.ttsProvider).toBe('local');
    expect(r.ttsModel).toBe('piper');
    expect(r.ttsVoice).toBe('en_US-amy-low');
  });

  it('downgrades ttsProvider=local when PIPER not set', async () => {
    TEST_PREFS = { ttsProvider: 'local', ttsModel: 'piper', ttsVoice: 'en_US-amy-low' };
    const r = await getResolvedPreferences('user-id');
    expect(r.ttsProvider).toBe('openai');
  });

  it('keeps imageProvider=local when isLocal + COMFYUI set', async () => {
    vi.stubEnv('COMFYUI_BASE_URL', 'http://localhost:8188');
    TEST_PREFS = { imageProvider: 'local', imageModel: 'comfyui:flux-schnell' };
    const r = await getResolvedPreferences('user-id');
    expect(r.imageProvider).toBe('local');
    expect(r.imageModel).toBe('comfyui:flux-schnell');
  });

  it('downgrades imageProvider=local when no image engine env set', async () => {
    TEST_PREFS = { imageProvider: 'local', imageModel: 'comfyui:flux-schnell' };
    const r = await getResolvedPreferences('user-id');
    expect(r.imageProvider).toBe('openai');
  });
});

describe('getResolvedPreferences — compactPrompt resolution (Plan C)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('PIPER_BASE_URL', '');
    vi.stubEnv('COMFYUI_BASE_URL', '');
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
    vi.stubEnv('MASTER_PROVIDER', '');
    vi.stubEnv('IMAGE_PROVIDER', '');
    vi.stubEnv('TTS_PROVIDER', '');
    TEST_PREFS = {};
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults compactPrompt=true when resolved aiProvider is local', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('local');
    expect(r.compactPrompt).toBe(true);
  });

  it('defaults compactPrompt=false when resolved aiProvider is cloud (anthropic)', async () => {
    TEST_PREFS = { aiProvider: 'anthropic', aiMasterModel: 'claude-sonnet-4-5' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
    expect(r.compactPrompt).toBe(false);
  });

  it('defaults compactPrompt=false when no provider is set (env fallback to anthropic)', async () => {
    TEST_PREFS = {};
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
    expect(r.compactPrompt).toBe(false);
  });

  it('explicit compactPrompt=false wins over local-provider default', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b', compactPrompt: false };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('local');
    expect(r.compactPrompt).toBe(false);
  });

  it('explicit compactPrompt=true wins over cloud-provider default', async () => {
    TEST_PREFS = { aiProvider: 'anthropic', compactPrompt: true };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
    expect(r.compactPrompt).toBe(true);
  });

  it('downgrade flips default: local→anthropic, undefined compactPrompt → false', async () => {
    // Stored aiProvider='local' but no OLLAMA env → downgrades to anthropic.
    // compactPrompt was never explicitly set, so it follows the *resolved*
    // provider (anthropic) → false. This is the documented behavior.
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
    expect(r.compactPrompt).toBe(false);
  });
});

// Note: getCampaignSettings shares the same resolveLocal* helpers as
// getResolvedPreferences (validated by the suite above), so we don't
// duplicate the test matrix here. The mock-db boundary makes it awkward
// to discriminate users/campaigns tables in a single Vitest mock.
