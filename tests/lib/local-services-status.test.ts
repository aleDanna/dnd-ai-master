import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchLocalServicesStatus } from '@/lib/local-services';

describe('fetchLocalServicesStatus', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('PIPER_BASE_URL', '');
    vi.stubEnv('XTTS_BASE_URL', '');
    vi.stubEnv('COMFYUI_BASE_URL', '');
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
    expect(r.tts.engines.xtts.enabled).toBe(false);
  });

  it('XTTS models are static even when service unreachable', async () => {
    vi.stubEnv('XTTS_BASE_URL', 'http://localhost:8055');
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refused'));
    const r = await fetchLocalServicesStatus();
    expect(r.tts.engines.xtts.enabled).toBe(true);
    expect(r.tts.engines.xtts.reachable).toBe(false);
    expect(r.tts.engines.xtts.models.length).toBeGreaterThan(0);  // static catalog
  });

  it('ComfyUI workflows are static even when service unreachable', async () => {
    vi.stubEnv('COMFYUI_BASE_URL', 'http://localhost:8188');
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refused'));
    const r = await fetchLocalServicesStatus();
    expect(r.image.engines.comfyui.enabled).toBe(true);
    expect(r.image.engines.comfyui.reachable).toBe(false);
    expect(r.image.engines.comfyui.models.length).toBeGreaterThan(0);
  });
});
