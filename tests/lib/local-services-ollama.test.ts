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

  it('returns every installed model verbatim (no whitelist)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'qwen3:30b-a3b',                        details: { parameter_size: '30B', quantization_level: 'Q4_K_M' } },
        { name: 'llama3.1:8b',                          details: { parameter_size: '8B'  } },
        { name: 'hf.co/unsloth/gpt-oss-20b-GGUF:F16',   details: { parameter_size: '20B', quantization_level: 'F16' } },
        { name: 'mistral:7b',                           details: { parameter_size: '7B'  } },
      ],
    }), { status: 200 }));

    const r = await fetchOllamaModels();
    expect(r).toHaveLength(4);
    expect(r.map((m) => m.slug)).toEqual([
      'qwen3:30b-a3b',
      'llama3.1:8b',
      'hf.co/unsloth/gpt-oss-20b-GGUF:F16',
      'mistral:7b',
    ]);
    // Label normalization still rewrites hf.co paths for readability.
    expect(r[2]?.label).toBe('unsloth/gpt-oss-20b (F16)');
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
