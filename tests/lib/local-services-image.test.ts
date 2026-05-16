import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDrawThingsModels, listComfyUIWorkflows } from '@/lib/local-services';

describe('listComfyUIWorkflows', () => {
  it('returns the hardcoded workflow list with flux-schnell first', () => {
    const r = listComfyUIWorkflows();
    expect(r[0]?.slug).toBe('comfyui:flux-schnell');
    expect(r[0]?.label).toBe('Flux.1 Schnell');
  });
});

describe('fetchDrawThingsModels', () => {
  beforeEach(() => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('maps /sdapi/v1/options.model into a single ModelOption', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      model: 'flux_1_schnell_q8p.ckpt',
      sd_model_checkpoint: 'flux_1_schnell_q8p',
    }), { status: 200 }));

    const r = await fetchDrawThingsModels();
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      slug: 'draw-things:flux_1_schnell_q8p.ckpt',
      label: 'flux_1_schnell_q8p',
      blurb: 'draw-things · active model',
    });
  });

  it('returns [] when options has no model field', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    expect(await fetchDrawThingsModels()).toEqual([]);
  });

  it('returns [] when fetch throws', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchDrawThingsModels()).toEqual([]);
  });

  it('returns [] when DRAW_THINGS_BASE_URL unset', async () => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
    expect(await fetchDrawThingsModels()).toEqual([]);
  });
});
