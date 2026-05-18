import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embed, embedBatch, pingEmbedder } from '@/ai/master/rag/embedder';

const config = { baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', timeoutMs: 5000 };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('embedder', () => {
  it('embed() POSTs to /api/embeddings and returns the vector', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: new Array(768).fill(0.5) }),
    });
    const v = await embed('hello world', config);
    expect(v).toHaveLength(768);
    expect(v[0]).toBe(0.5);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('http://localhost:11434/api/embeddings');
    const body = JSON.parse(call[1]!.body as string);
    expect(body).toEqual({ model: 'nomic-embed-text', prompt: 'hello world', keep_alive: '30m' });
  });

  it('embedBatch() embeds inputs sequentially and returns vectors in order', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [1, 0, 0] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0, 1, 0] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0, 0, 1] }) });
    const vs = await embedBatch(['a', 'b', 'c'], config);
    expect(vs).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('embed() throws on non-OK HTTP response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(embed('x', config)).rejects.toThrow(/embedder.*500.*boom/i);
  });

  it('pingEmbedder() returns true when /api/embeddings responds successfully', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0] }) });
    expect(await pingEmbedder(config)).toBe(true);
  });

  it('pingEmbedder() returns false on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await pingEmbedder(config)).toBe(false);
  });
});
