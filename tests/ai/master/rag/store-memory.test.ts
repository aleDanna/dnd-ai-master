import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '@/ai/master/rag/store-memory';

const chunkA = { source: 'lore' as const, sectionPath: 'A', content: 'apple banana', embedding: [1, 0, 0] };
const chunkB = { source: 'lore' as const, sectionPath: 'B', content: 'carrot dragonfruit', embedding: [0, 1, 0] };
const chunkC = { source: 'lore' as const, sectionPath: 'C', content: 'eggplant fig', embedding: [0, 0, 1] };

describe('memory store', () => {
  it('returns nearest by cosine distance', async () => {
    const s = createMemoryStore();
    await s.replaceAll('hash-1', [chunkA, chunkB, chunkC]);
    const r = await s.query([1, 0.1, 0], 2);
    expect(r).toHaveLength(2);
    expect(r[0]!.sectionPath).toBe('A');
  });

  it('empty store returns empty array', async () => {
    const s = createMemoryStore();
    const r = await s.query([1, 0, 0], 3);
    expect(r).toEqual([]);
  });

  it('replaceAll() wipes previous content', async () => {
    const s = createMemoryStore();
    await s.replaceAll('h1', [chunkA, chunkB]);
    await s.replaceAll('h2', [chunkC]);
    const r = await s.query([0, 0, 1], 3);
    expect(r).toHaveLength(1);
    expect(r[0]!.sectionPath).toBe('C');
  });

  it('currentHash() returns the hash set by replaceAll', async () => {
    const s = createMemoryStore();
    expect(await s.currentHash()).toBeNull();
    await s.replaceAll('abc123', [chunkA]);
    expect(await s.currentHash()).toBe('abc123');
  });

  it('attaches distance to results (lower = more relevant)', async () => {
    const s = createMemoryStore();
    await s.replaceAll('h', [chunkA, chunkB]);
    const r = await s.query([1, 0, 0], 2);
    expect(r[0]!.distance).toBeLessThan(r[1]!.distance);
  });
});
