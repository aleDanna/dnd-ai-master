import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPiperVoices, listXttsVoices } from '@/lib/local-services';

describe('fetchPiperVoices', () => {
  beforeEach(() => {
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('maps /v1/audio/voices to ModelOption[]', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'en_US-amy-low',    language: 'en_US', quality: 'low' },
      { id: 'it_IT-riccardo-x', language: 'it_IT', quality: 'x_low' },
    ]), { status: 200 }));

    const r = await fetchPiperVoices();
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ slug: 'en_US-amy-low', label: 'en_US-amy-low', blurb: 'en_US · low' });
    expect(r[1]).toEqual({ slug: 'it_IT-riccardo-x', label: 'it_IT-riccardo-x', blurb: 'it_IT · x_low' });
  });

  it('returns [] when fetch throws', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchPiperVoices()).toEqual([]);
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
