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

  it('maps /sdapi/v1/sd-models with draw-things: slug prefix', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify([
      { title: 'Realistic Vision v6.0 [abc123]', model_name: 'realisticVisionV60' },
      { title: 'SDXL Base 1.0 [def456]', model_name: 'sdxlBase10' },
    ]), { status: 200 }));

    const r = await fetchDrawThingsModels();
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      slug: 'draw-things:realisticVisionV60',
      label: 'Realistic Vision v6.0 [abc123]',
      blurb: 'draw-things · core-ml',
    });
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
