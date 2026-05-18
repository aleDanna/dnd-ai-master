import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPiperVoices } from '@/lib/local-services';

describe('fetchPiperVoices', () => {
  beforeEach(() => {
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured voices (6 OpenAI-compat + 2 italian)', async () => {
    const r = await fetchPiperVoices();
    expect(r.map((m) => m.slug)).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'paola', 'riccardo']);
    expect(r[0]?.slug).toBe('alloy');
  });

  it('returns [] when PIPER_BASE_URL unset', async () => {
    vi.stubEnv('PIPER_BASE_URL', '');
    expect(await fetchPiperVoices()).toEqual([]);
  });
});
