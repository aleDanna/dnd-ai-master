import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '@/ai/master/rag/chunker';

describe('chunkMarkdown', () => {
  it('splits on H2 headings and preserves the heading in the chunk', () => {
    const md = '# Title\n\n## Section A\n\nLorem ipsum.\n\n## Section B\n\nDolor sit.';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sectionPath).toBe('Section A');
    expect(chunks[0]!.content).toContain('Lorem ipsum.');
    expect(chunks[1]!.sectionPath).toBe('Section B');
    expect(chunks[1]!.content).toContain('Dolor sit.');
  });

  it('splits on H3 within an H2 and concatenates the path', () => {
    const md = '## Section A\n\n### Sub 1\n\none\n\n### Sub 2\n\ntwo';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sectionPath).toBe('Section A > Sub 1');
    expect(chunks[1]!.sectionPath).toBe('Section A > Sub 2');
  });

  it('splits oversize sections into multiple chunks honoring maxTokens (chars/4)', () => {
    const big = 'word '.repeat(2000);
    const md = `## Big\n\n${big}`;
    const chunks = chunkMarkdown('handbook', md, { maxTokens: 300, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1300);
      expect(c.sectionPath).toBe('Big');
      expect(c.source).toBe('handbook');
    }
  });

  it('applies token overlap between consecutive splits within the same section', () => {
    const text = 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z';
    const md = `## S\n\n${text}`;
    const chunks = chunkMarkdown('lore', md, { maxTokens: 5, overlapTokens: 2 });
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0]!.content.split(/\s+/);
    const second = chunks[1]!.content.split(/\s+/);
    const overlap = first.slice(-2);
    expect(second.slice(0, 2)).toEqual(overlap);
  });

  it('skips empty sections', () => {
    const md = '## A\n\n\n\n## B\n\nreal content';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sectionPath).toBe('B');
  });

  it('handles documents with no headings as a single chunk', () => {
    const md = 'Just some prose without any heading.';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sectionPath).toBe('(root)');
    expect(chunks[0]!.content).toContain('Just some prose');
  });
});
