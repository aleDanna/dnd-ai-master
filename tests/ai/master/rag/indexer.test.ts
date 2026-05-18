import { describe, it, expect, vi } from 'vitest';
import { rebuildIndex, computeCorpusHash } from '@/ai/master/rag/indexer';
import { createMemoryStore } from '@/ai/master/rag/store-memory';

const handbookMd = '## A\n\napple banana cherry';
const loreMd = '## B\n\ndragon elf fairy';

describe('indexer', () => {
  it('computeCorpusHash() is stable and changes when input changes', () => {
    const h1 = computeCorpusHash(handbookMd, loreMd);
    const h2 = computeCorpusHash(handbookMd, loreMd);
    expect(h1).toBe(h2);
    const h3 = computeCorpusHash(handbookMd + ' changed', loreMd);
    expect(h3).not.toBe(h1);
  });

  it('rebuildIndex() loads handbook + lore, chunks, embeds, writes to store', async () => {
    const store = createMemoryStore();
    const embedFn = vi.fn(async (text: string) => Array.from({ length: 3 }, (_, i) => text.charCodeAt(i) || 0));
    await rebuildIndex({
      handbookMd,
      loreMd,
      store,
      embedFn,
    });
    expect(embedFn).toHaveBeenCalled();
    expect(await store.currentHash()).toBe(computeCorpusHash(handbookMd, loreMd));
    const r = await store.query([1, 0, 0], 10);
    expect(r.length).toBeGreaterThan(0);
  });

  it('rebuildIndex() is a no-op when hash matches the store', async () => {
    const store = createMemoryStore();
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);
    await store.replaceAll(computeCorpusHash(handbookMd, loreMd), [
      { source: 'lore', sectionPath: 'X', content: 'x', embedding: [1, 0, 0] },
    ]);
    embedFn.mockClear();
    const result = await rebuildIndex({ handbookMd, loreMd, store, embedFn });
    expect(result.skipped).toBe(true);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('rebuildIndex() force=true re-indexes even when hash matches', async () => {
    const store = createMemoryStore();
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);
    await store.replaceAll(computeCorpusHash(handbookMd, loreMd), []);
    await rebuildIndex({ handbookMd, loreMd, store, embedFn, force: true });
    expect(embedFn).toHaveBeenCalled();
  });
});
