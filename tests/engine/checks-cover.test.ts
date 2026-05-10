import { describe, it, expect } from 'vitest';
import { savingThrow } from '@/engine/checks';
import { makeSeededRng } from '@/engine/rand';
import type { Character } from '@/engine/types';

const fighter: Character = {
  id: 'pc1',
  name: 'Tharion',
  level: 3,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 28,
  ac: 16,
  speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'],
    skills: ['Athletics'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    tools: [],
    languages: ['Common'],
  },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 3,
  hitDieSize: 10,
};

describe('savingThrow — cover (PHB §3.12)', () => {
  it('DEX save with half cover adds +2 to modifier', () => {
    const baseline = savingThrow({ char: fighter, ability: 'DEX', dc: 15 }, makeSeededRng(7));
    const withCover = savingThrow(
      { char: fighter, ability: 'DEX', dc: 15, cover: 'half' },
      makeSeededRng(7),
    );
    expect(withCover.rolls[0]!.modifier - baseline.rolls[0]!.modifier).toBe(2);
  });

  it('DEX save with three-quarters cover adds +5', () => {
    const baseline = savingThrow({ char: fighter, ability: 'DEX', dc: 15 }, makeSeededRng(7));
    const withCover = savingThrow(
      { char: fighter, ability: 'DEX', dc: 15, cover: 'three-quarters' },
      makeSeededRng(7),
    );
    expect(withCover.rolls[0]!.modifier - baseline.rolls[0]!.modifier).toBe(5);
  });

  it('STR save with half cover is unaffected by cover', () => {
    const baseline = savingThrow({ char: fighter, ability: 'STR', dc: 15 }, makeSeededRng(7));
    const withCover = savingThrow(
      { char: fighter, ability: 'STR', dc: 15, cover: 'half' },
      makeSeededRng(7),
    );
    expect(withCover.rolls[0]!.modifier).toBe(baseline.rolls[0]!.modifier);
  });

  it('CON save with three-quarters cover is unaffected', () => {
    const baseline = savingThrow({ char: fighter, ability: 'CON', dc: 15 }, makeSeededRng(7));
    const withCover = savingThrow(
      { char: fighter, ability: 'CON', dc: 15, cover: 'three-quarters' },
      makeSeededRng(7),
    );
    expect(withCover.rolls[0]!.modifier).toBe(baseline.rolls[0]!.modifier);
  });

  it('DEX save with cover none is identical to omitted cover', () => {
    const r1 = savingThrow({ char: fighter, ability: 'DEX', dc: 15 }, makeSeededRng(11));
    const r2 = savingThrow({ char: fighter, ability: 'DEX', dc: 15, cover: 'none' }, makeSeededRng(11));
    expect(r2.rolls[0]!.modifier).toBe(r1.rolls[0]!.modifier);
  });
});
