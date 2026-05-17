import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieveRelevant } from '@/ai/master/rag/retriever';
import type { RagStore } from '@/ai/master/rag/store-memory';
import type { RetrievedChunk } from '@/ai/master/rag/types';

function mockStore(chunks: RetrievedChunk[]): RagStore {
  return {
    replaceAll: vi.fn(),
    currentHash: vi.fn().mockResolvedValue('h'),
    query: vi.fn().mockResolvedValue(chunks),
  };
}

const embedderOk = vi.fn().mockResolvedValue([1, 0, 0]);
const embedderDown = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

describe('retrieveRelevant', () => {
  beforeEach(() => {
    embedderOk.mockClear();
    embedderDown.mockClear();
  });
  it('returns top-K chunks from the store, deduped by sectionPath', async () => {
    const store = mockStore([
      { source: 'lore', sectionPath: 'A', content: 'a1', distance: 0.1 },
      { source: 'lore', sectionPath: 'A', content: 'a2', distance: 0.2 },
      { source: 'lore', sectionPath: 'B', content: 'b',  distance: 0.3 },
      { source: 'lore', sectionPath: 'C', content: 'c',  distance: 0.4 },
    ]);
    const r = await retrieveRelevant({ query: 'q', store, embedFn: embedderOk, k: 3 });
    expect(r.map((c) => c.sectionPath)).toEqual(['A', 'B', 'C']);
  });

  it('returns empty list (gracefully) when embedder throws', async () => {
    const store = mockStore([]);
    const r = await retrieveRelevant({ query: 'q', store, embedFn: embedderDown, k: 3 });
    expect(r).toEqual([]);
  });

  it('returns empty list when store has no chunks', async () => {
    const store = mockStore([]);
    const r = await retrieveRelevant({ query: 'q', store, embedFn: embedderOk, k: 3 });
    expect(r).toEqual([]);
  });

  it('returns empty list when query string is empty', async () => {
    const store = mockStore([{ source: 'lore', sectionPath: 'A', content: 'a', distance: 0 }]);
    const r = await retrieveRelevant({ query: '', store, embedFn: embedderOk, k: 3 });
    expect(r).toEqual([]);
    expect(embedderOk).not.toHaveBeenCalled();
  });
});
