import { describe, it, expect } from 'vitest';
import { parseSpells } from '@/srd/parsers/spells';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const csv = readFileSync(
  fileURLToPath(new URL('../../../data/spells.csv', import.meta.url)),
  'utf8',
);

describe('parseSpells', () => {
  const spells = parseSpells(csv);

  it('contains many spells', () => {
    expect(spells.length).toBeGreaterThan(50);
  });

  it('parses cantrips as level 0', () => {
    const acidSplash = spells.find((s) => s.name === 'Acid Splash');
    expect(acidSplash?.level).toBe(0);
  });

  it('parses concentration and ritual as booleans', () => {
    const chillTouch = spells.find((s) => s.name === 'Chill Touch');
    expect(chillTouch?.concentration).toBe(false);
    expect(chillTouch?.ritual).toBe(false);
  });

  it('parses class list as array', () => {
    const acidSplash = spells.find((s) => s.name === 'Acid Splash');
    expect(acidSplash?.classes).toEqual(expect.arrayContaining(['Sorcerer', 'Wizard']));
  });
});
