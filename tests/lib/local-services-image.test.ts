import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDrawThingsModels } from '@/lib/local-services';

describe('fetchDrawThingsModels', () => {
  beforeEach(() => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('maps /sdapi/v1/options.model into a single ModelOption when checkpoint is loaded', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      model: 'flux_1_schnell_q8p.ckpt',
      sd_model_checkpoint: 'flux_1_schnell_q8p',
    }), { status: 200 }));

    const r = await fetchDrawThingsModels();
    expect(r).toHaveLength(1);
    expect(r[0]?.slug).toBe('draw-things:flux_1_schnell_q8p.ckpt');
    expect(r[0]?.label).toBe('flux_1_schnell_q8p');
  });

  it('returns a placeholder when options has no model field (so the Settings UI is non-empty)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const r = await fetchDrawThingsModels();
    expect(r).toHaveLength(1);
    expect(r[0]?.slug).toBe('draw-things:active');
    expect(r[0]?.label).toMatch(/Active checkpoint/);
  });

  it('returns a placeholder when fetch throws (proxy down etc.)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const r = await fetchDrawThingsModels();
    expect(r).toHaveLength(1);
    expect(r[0]?.slug).toBe('draw-things:active');
  });

  it('returns [] when DRAW_THINGS_BASE_URL unset (engine disabled at env level)', async () => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
    expect(await fetchDrawThingsModels()).toEqual([]);
  });
});
