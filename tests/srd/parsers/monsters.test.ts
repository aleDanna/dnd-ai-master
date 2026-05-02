import { describe, it, expect } from 'vitest';
import { parseMonsters } from '@/srd/parsers/monsters';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const csv = readFileSync(
  fileURLToPath(new URL('../../../data/monsters.csv', import.meta.url)),
  'utf8',
);

describe('parseMonsters', () => {
  const monsters = parseMonsters(csv);

  it('contains many monsters', () => {
    expect(monsters.length).toBeGreaterThan(50);
  });

  it('parses ape', () => {
    const ape = monsters.find((m) => m.name === 'Ape');
    expect(ape).toBeDefined();
    expect(ape!.size).toBe('Medium');
    expect(ape!.ac).toBe(12);
    expect(ape!.hp).toBe(19);
    expect(ape!.str).toBe(16);
  });

  it('parses cr 1/2 as 0.5', () => {
    const ape = monsters.find((m) => m.name === 'Ape');
    expect(Number(ape!.cr)).toBe(0.5);
  });

  it('parses actions as array', () => {
    const ape = monsters.find((m) => m.name === 'Ape');
    expect(Array.isArray(ape!.actions)).toBe(true);
    expect(ape!.actions!.length).toBeGreaterThan(0);
  });
});
