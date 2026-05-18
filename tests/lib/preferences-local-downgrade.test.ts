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

  it('keeps imageProvider=local when isLocal + DRAW_THINGS set', async () => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    TEST_PREFS = { imageProvider: 'local', imageModel: 'draw-things:active' };
    const r = await getResolvedPreferences('user-id');
    expect(r.imageProvider).toBe('local');
    expect(r.imageModel).toBe('draw-things:active');
  });

  it('downgrades imageProvider=local when no image engine env set', async () => {
    TEST_PREFS = { imageProvider: 'local', imageModel: 'draw-things:active' };
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
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
    vi.stubEnv('MASTER_PROVIDER', '');
    vi.stubEnv('IMAGE_PROVIDER', '');
    vi.stubEnv('TTS_PROVIDER', '');
    TEST_PREFS = {};
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults compactPrompt=true regardless of provider (UI toggle removed; always-on policy)', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r1 = await getResolvedPreferences('user-id');
    expect(r1.compactPrompt).toBe(true);

    TEST_PREFS = { aiProvider: 'anthropic', aiMasterModel: 'claude-sonnet-4-5' };
    const r2 = await getResolvedPreferences('user-id');
    expect(r2.aiProvider).toBe('anthropic');
    expect(r2.compactPrompt).toBe(true);

    TEST_PREFS = {};
    const r3 = await getResolvedPreferences('user-id');
    expect(r3.compactPrompt).toBe(true);
  });

  it('explicit compactPrompt=false still wins over the always-on default', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b', compactPrompt: false };
    const r = await getResolvedPreferences('user-id');
    expect(r.compactPrompt).toBe(false);
  });

  it('explicit compactPrompt=true wins over default (and stays on)', async () => {
    TEST_PREFS = { aiProvider: 'anthropic', compactPrompt: true };
    const r = await getResolvedPreferences('user-id');
    expect(r.compactPrompt).toBe(true);
  });
});

// Note: getCampaignSettings shares the same resolveLocal* helpers as
// getResolvedPreferences (validated by the suite above), so we don't
// duplicate the test matrix here. The mock-db boundary makes it awkward
// to discriminate users/campaigns tables in a single Vitest mock.
