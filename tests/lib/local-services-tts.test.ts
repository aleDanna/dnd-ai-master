import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPiperVoices, listXttsVoices } from '@/lib/local-services';

describe('fetchPiperVoices', () => {
  beforeEach(() => {
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the 6 OpenAI-compat voices that openedai-speech-min recognizes', async () => {
    const r = await fetchPiperVoices();
    expect(r.map((m) => m.slug)).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    expect(r[0]).toEqual({ slug: 'alloy', label: 'alloy', blurb: 'piper · openai-compat' });
  });

  it('returns [] when PIPER_BASE_URL unset', async () => {
    vi.stubEnv('PIPER_BASE_URL', '');
    expect(await fetchPiperVoices()).toEqual([]);
  });
});

describe('listXttsVoices', () => {
  it('returns ModelOption per XTTS_LANGUAGES entry', () => {
    const r = listXttsVoices();
    expect(r.length).toBeGreaterThanOrEqual(9);
    const en = r.find((m) => m.slug === 'en');
    expect(en).toEqual({ slug: 'en', label: 'English (default)', blurb: 'xtts · neural' });
    const it = r.find((m) => m.slug === 'it');
    expect(it).toEqual({ slug: 'it', label: 'Italian (default)', blurb: 'xtts · neural' });
  });
});
