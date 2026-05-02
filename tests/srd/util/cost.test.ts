import { describe, it, expect } from 'vitest';
import { parseCostToCp } from '@/srd/util/cost';

describe('parseCostToCp', () => {
  it.each([
    ['1 cp', 1],
    ['1 sp', 10],
    ['1 gp', 100],
    ['1 pp', 1000],
    ['5 gp', 500],
    ['25 gp', 2500],
    ['2 sp', 20],
    ['1 ep', 50],
  ])('parses %s as %i cp', (input, cp) => {
    expect(parseCostToCp(input)).toBe(cp);
  });

  it('handles em-dash as zero', () => {
    expect(parseCostToCp('—')).toBe(0);
    expect(parseCostToCp('-')).toBe(0);
  });

  it('throws on unknown unit', () => {
    expect(() => parseCostToCp('5 zz')).toThrow();
  });

  it('throws on bad number', () => {
    expect(() => parseCostToCp('foo gp')).toThrow();
  });
});
