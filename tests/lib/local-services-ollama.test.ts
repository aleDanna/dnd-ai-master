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

  it('surfaces curated baked tiers AND raw generative bases; hides stale bakes (REQ-031/032/034)', async () => {
    // Phase 03 (03-C-04) stripped the dropdown to dnd-master-plus only,
    // assuming a "raw-slug" Settings path that never existed → the dropdown
    // could go empty and REQ-031/032/034 (pick the base primary/fallback/
    // content model via Settings) were unsatisfiable. The dropdown now also
    // surfaces RAW generative base models. Stale baked variants
    // (dnd-master-max / dnd-master-lite — not in TIER_LABELS after the strip)
    // remain hidden to avoid confusing duplicates.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'qwen3:30b-a3b',     details: { parameter_size: '30B', quantization_level: 'Q4_K_M', family: 'qwen3moe' } },
        { name: 'dnd-master-max',    details: { parameter_size: '30B', quantization_level: 'Q4_K_M' } },
        { name: 'llama3.2:3b',       details: { parameter_size: '3B', family: 'llama' } },
        { name: 'dnd-master-lite',   details: { parameter_size: '3B'  } },
        { name: 'gpt-oss:20b',       details: { parameter_size: '20B', family: 'gptoss' } },
        { name: 'dnd-master-plus',   details: { parameter_size: '20B' } },
      ],
    }), { status: 200 }));

    const r = await fetchOllamaModels();
    // Curated baked (dnd-master-plus) + whitelisted raw bases; stale bakes
    // hidden. Since the 2026-06-10 model-governance audit the raw list is
    // also gated on matchesLlmWhitelist: llama3.2:3b (and gemma4 et al.)
    // are no longer selectable — the never-validated gemma4 experiment is
    // what triggered the weak-tool hotfix cascade (commits 769029c..2aea307).
    expect(r.map((m) => m.slug).sort()).toEqual([
      'dnd-master-plus',
      'gpt-oss:20b',
      'qwen3:30b-a3b',
    ]);
    expect(r.find((m) => m.slug === 'dnd-master-plus')?.kind).toBe('baked');
    expect(r.find((m) => m.slug === 'qwen3:30b-a3b')?.kind).toBe('raw');
    expect(r.map((m) => m.slug)).not.toContain('dnd-master-max');
    expect(r.map((m) => m.slug)).not.toContain('dnd-master-lite');
    expect(r.map((m) => m.slug)).not.toContain('llama3.2:3b');
  });

  it('excludes embedders AND non-validated families (gemma4) from the dropdown', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'qwen3:30b-a3b',            details: { parameter_size: '30B', family: 'qwen3moe' } },
        { name: 'mistral-small3.2:24b',     details: { parameter_size: '24B', family: 'mistral' } },
        { name: 'gemma4:latest',            details: { parameter_size: '8B', family: 'gemma4' } },
        { name: 'nomic-embed-text:latest',  details: { parameter_size: '137M', family: 'nomic-bert' } },
        { name: 'mxbai-embed-large:latest', details: { parameter_size: '335M', family: 'bert' } },
      ],
    }), { status: 200 }));

    const r = await fetchOllamaModels();
    expect(r.map((m) => m.slug).sort()).toEqual(['mistral-small3.2:24b', 'qwen3:30b-a3b']);
    expect(r.map((m) => m.slug).join(',')).not.toMatch(/embed/);
    expect(r.map((m) => m.slug)).not.toContain('gemma4:latest');
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
