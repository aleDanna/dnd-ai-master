import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchOllamaModels } from '@/lib/local-services';

describe('fetchOllamaModels', () => {
  beforeEach(() => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns ONLY the dnd-master-plus baked baseline (Phase 03 strip — REQ-033)', async () => {
    // Pre-Phase-03 the Settings dropdown surfaced dnd-master-{lite,max,max2,
    // max3,plus}. After the TIER_NAMES strip in 03-C-04 only dnd-master-plus
    // remains as a curated tier (regression baseline). Stale baked variants
    // still installed on the host (the fixture below includes
    // dnd-master-max / dnd-master-lite to simulate that case) are hidden
    // from the dropdown because TIER_LABELS no longer contains their slug —
    // the user picks the underlying base model directly via the raw-slug
    // path in Settings (REQ-031 / REQ-032 / REQ-030).
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'qwen3:30b-a3b',     details: { parameter_size: '30B', quantization_level: 'Q4_K_M' } },
        { name: 'dnd-master-max',    details: { parameter_size: '30B', quantization_level: 'Q4_K_M' } },
        { name: 'llama3.2:3b',       details: { parameter_size: '3B'  } },
        { name: 'dnd-master-lite',   details: { parameter_size: '3B'  } },
        { name: 'gpt-oss:20b',       details: { parameter_size: '20B' } },
        { name: 'dnd-master-plus',   details: { parameter_size: '20B' } },
      ],
    }), { status: 200 }));

    const r = await fetchOllamaModels();
    expect(r.map((m) => m.slug).sort()).toEqual([
      'dnd-master-plus',
    ]);
    expect(r.every((m) => m.kind === 'baked')).toBe(true);
  });

  it('returns [] when fetch throws', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    expect(await fetchOllamaModels()).toEqual([]);
  });

  it('returns [] when OLLAMA_BASE_URL is unset', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', '');
    expect(await fetchOllamaModels()).toEqual([]);
  });

  it('returns [] when /api/tags returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('boom', { status: 500 }));
    expect(await fetchOllamaModels()).toEqual([]);
  });
});
