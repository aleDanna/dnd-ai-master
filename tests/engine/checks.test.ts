import { describe, it, expect } from 'vitest';
import { abilityCheck, savingThrow, contestedCheck, passiveCheck, groupCheck } from '@/engine/checks';
import { makeSeededRng } from '@/engine/rand';
import type { Character } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 3, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 28, ac: 16, speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'], skills: ['Athletics', 'Intimidation'], expertise: [],
    weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'],
  },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 3, hitDieSize: 10,
};

describe('abilityCheck', () => {
  it('rolls d20 + STR + prof for Athletics with DC, ok = total >= dc', () => {
    const r = abilityCheck({ char: fighter, skill: 'Athletics', dc: 15 }, makeSeededRng(1));
    expect(r.rolls.length).toBe(1);
    expect(r.rolls[0]!.modifier).toBe(3 + 2);                    // STR mod 3 + prof 2
    expect(r.data?.dc).toBe(15);
    expect(typeof r.ok).toBe('boolean');
    expect(r.ok).toBe(r.rolls[0]!.total >= 15);
  });

  it('uses raw ability modifier when skill omitted', () => {
    const r = abilityCheck({ char: fighter, ability: 'STR', dc: 10 }, makeSeededRng(1));
    expect(r.rolls[0]!.modifier).toBe(3);                         // STR only, no prof
  });

  it('passes advantage/disadvantage to roll', () => {
    const r = abilityCheck({ char: fighter, skill: 'Athletics', dc: 10, advantage: true }, makeSeededRng(1));
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.advantage).toBe(true);
  });
});

describe('savingThrow', () => {
  it('adds save proficiency when character is proficient', () => {
    const r = savingThrow({ char: fighter, ability: 'STR', dc: 12 }, makeSeededRng(1));
    expect(r.rolls[0]!.modifier).toBe(3 + 2);
  });

  it('omits proficiency when not proficient', () => {
    const r = savingThrow({ char: fighter, ability: 'INT', dc: 12 }, makeSeededRng(1));
    expect(r.rolls[0]!.modifier).toBe(0);
  });
});

describe('contestedCheck', () => {
  it('returns the higher-rolling side', () => {
    // Use a fixed RNG that produces specific values
    const r = contestedCheck(
      { char: fighter, skill: 'Athletics' },
      { char: fighter, skill: 'Athletics' },
      makeSeededRng(1),
    );
    expect(r.rolls.length).toBe(2);
    expect(r.data?.winner).toMatch(/^[ab]$|^tie$/);
  });
});

describe('passiveCheck', () => {
  it('returns the static passive score and a synthetic dice roll for logging', () => {
    const r = passiveCheck({ char: fighter, skill: 'Athletics' });
    // Passive Athletics = 10 + STR(3) + prof(2) = 15
    expect(r.data?.passive).toBe(15);
    expect(r.rolls.length).toBe(1);
    expect(r.rolls[0]!.formula).toBe('passive');
  });
});

describe('groupCheck', () => {
  it('passes when at least half the group succeeds', () => {
    const a: Character = { ...fighter, id: 'a' };
    const b: Character = { ...fighter, id: 'b' };
    const c: Character = { ...fighter, id: 'c' };
    const r = groupCheck({ chars: [a, b, c], skill: 'Athletics', dc: 5 }, makeSeededRng(1));
    expect(r.rolls.length).toBe(3);
    const successes = r.rolls.filter((x) => x.total >= 5).length;
    expect(r.ok).toBe(successes >= 2);                                 // ceil(3/2) = 2
  });
});
