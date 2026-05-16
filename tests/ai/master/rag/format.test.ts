import { describe, it, expect } from 'vitest';
import { formatRagBlock } from '@/ai/master/rag/format';

describe('formatRagBlock', () => {
  it('produces a labelled block with each chunk grouped by source/path', () => {
    const block = formatRagBlock([
      { source: 'handbook', sectionPath: 'Pacing > Combat tempo', content: 'tempo content', distance: 0.1 },
      { source: 'lore', sectionPath: 'Magic Systems > Divine magic', content: 'divine content', distance: 0.2 },
    ]);
    expect(block).toMatch(/RELEVANT CONTEXT/);
    expect(block).toMatch(/handbook > Pacing > Combat tempo/);
    expect(block).toMatch(/tempo content/);
    expect(block).toMatch(/lore > Magic Systems > Divine magic/);
    expect(block).toMatch(/divine content/);
  });

  it('returns empty string when given no chunks', () => {
    expect(formatRagBlock([])).toBe('');
  });
});
