import { describe, it, expect } from 'vitest';
import { parseRaces } from '@/srd/parsers/races';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const csv = readFileSync(
  fileURLToPath(new URL('../../../data/races.csv', import.meta.url)),
  'utf8',
);

describe('parseRaces', () => {
  const races = parseRaces(csv);

  it('returns at least the 9 base races', () => {
    expect(races.length).toBeGreaterThanOrEqual(9);
  });

  it('parses ability score increases as a record', () => {
    const dwarf = races.find((r) => r.name === 'Dwarf');
    expect(dwarf?.abilityScoreIncrease).toEqual({ CON: 2 });
  });

  it('links subraces to their parent', () => {
    const hillDwarf = races.find((r) => r.name === 'Hill Dwarf');
    expect(hillDwarf?.parentRaceSlug).toBe('dwarf');
  });

  it('parses speed as integer', () => {
    const human = races.find((r) => r.name === 'Human');
    expect(typeof human?.speed).toBe('number');
    expect(human?.speed).toBeGreaterThan(0);
  });
});
