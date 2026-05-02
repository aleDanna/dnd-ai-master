import { describe, it, expect } from 'vitest';
import { parseRules } from '@/srd/parsers/rules';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const md = readFileSync(
  fileURLToPath(new URL('../../../data/rules.md', import.meta.url)),
  'utf8',
);

describe('parseRules', () => {
  const rules = parseRules(md);

  it('produces several sections', () => {
    expect(rules.length).toBeGreaterThan(10);
  });

  it('captures section_path with numeric prefix', () => {
    const advantage = rules.find((r) => r.sectionPath === '1.3 Advantage and Disadvantage');
    expect(advantage).toBeDefined();
  });

  it('produces a slug anchor', () => {
    const advantage = rules.find((r) => r.sectionPath === '1.3 Advantage and Disadvantage');
    expect(advantage?.anchor).toBe('1-3-advantage-and-disadvantage');
  });

  it('keeps markdown body for the section', () => {
    const advantage = rules.find((r) => r.sectionPath === '1.3 Advantage and Disadvantage');
    expect(advantage?.markdown).toMatch(/Advantage/);
    expect(advantage?.markdown).toMatch(/2d20/);
  });

  it('does not include the header line itself in the body', () => {
    const advantage = rules.find((r) => r.sectionPath === '1.3 Advantage and Disadvantage');
    expect(advantage?.markdown.startsWith('### 1.3')).toBe(false);
  });
});
