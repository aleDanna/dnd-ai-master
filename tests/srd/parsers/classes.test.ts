import { describe, it, expect } from 'vitest';
import { parseClasses } from '@/srd/parsers/classes';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const csv = readFileSync(
  fileURLToPath(new URL('../../../data/classes.csv', import.meta.url)),
  'utf8',
);

describe('parseClasses', () => {
  const classes = parseClasses(csv);

  it('returns at least the 12 PHB classes', () => {
    expect(classes.length).toBeGreaterThanOrEqual(12);
  });

  it('produces stable slugs', () => {
    const barbarian = classes.find((c) => c.name === 'Barbarian');
    expect(barbarian?.slug).toBe('barbarian');
  });

  it('parses primary ability as a list', () => {
    const wizard = classes.find((c) => c.name === 'Wizard');
    expect(wizard?.primaryAbility).toContain('Intelligence');
  });

  it('parses saving throws as ability codes', () => {
    const fighter = classes.find((c) => c.name === 'Fighter');
    expect(fighter?.savingThrows).toEqual(expect.arrayContaining(['STR', 'CON']));
  });

  it('detects spellcasting type for full casters', () => {
    const wizard = classes.find((c) => c.name === 'Wizard');
    expect(wizard?.spellcasting).toEqual({ ability: 'Intelligence', type: 'Full' });
  });

  it('returns null spellcasting for non-casters', () => {
    const barbarian = classes.find((c) => c.name === 'Barbarian');
    expect(barbarian?.spellcasting).toBeNull();
  });

  it('parses key features as level-keyed list', () => {
    const fighter = classes.find((c) => c.name === 'Fighter');
    const lvl1 = fighter?.keyFeatures?.find((f) => f.level === 1);
    expect(lvl1).toBeDefined();
    expect(lvl1!.features.length).toBeGreaterThan(0);
  });
});
