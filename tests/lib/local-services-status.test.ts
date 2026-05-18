import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchLocalServicesStatus } from '@/lib/local-services';

describe('fetchLocalServicesStatus', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('PIPER_BASE_URL', '');
    vi.stubEnv('DRAW_THINGS_BASE_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports isLocal:false in production with everything empty', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = await fetchLocalServicesStatus();
    expect(r.isLocal).toBe(false);
    expect(r.ai.enabled).toBe(false);
    expect(r.tts.enabled).toBe(false);
    expect(r.image.enabled).toBe(false);
  });

  it('reports enabled=true for surfaces with env set, even when unreachable', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refused'));

    const r = await fetchLocalServicesStatus();
    expect(r.ai.enabled).toBe(true);
    expect(r.ai.reachable).toBe(false);
    expect(r.tts.enabled).toBe(true);
    expect(r.tts.engines.piper.enabled).toBe(true);
    expect(r.tts.engines.piper.reachable).toBe(false);
  });

  it('Draw Things engine exposes a placeholder model when reachable but no checkpoint loaded', async () => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(JSON.stringify({ model: null }), { status: 200 }));
    const r = await fetchLocalServicesStatus();
    expect(r.image.engines.drawThings.enabled).toBe(true);
    expect(r.image.engines.drawThings.reachable).toBe(true);
    expect(r.image.engines.drawThings.models.length).toBe(1);
    expect(r.image.engines.drawThings.models[0]?.slug).toBe('draw-things:active');
  });
});
