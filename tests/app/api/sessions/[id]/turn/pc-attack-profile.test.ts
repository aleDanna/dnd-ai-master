import { describe, it, expect } from 'vitest';
import { buildPcAttackProfile } from '@/app/api/sessions/[id]/turn/pc-attack-profile';

/**
 * 2026-06-10 audit — RAW attack math from the character sheet (rules.md §1.1,
 * §10): to-hit = ability mod + PB; damage = weapon dice + ability mod ONLY
 * (proficiency never applies to damage). Ability selection: ranged → DEX,
 * finesse → max(STR, DEX), melee → STR.
 */
describe('buildPcAttackProfile', () => {
  const abilities = { STR: 16, DEX: 14 }; // +3 / +2

  it('melee weapon: STR mod + PB to hit, STR mod only on damage', () => {
    const p = buildPcAttackProfile({
      abilities,
      level: 1, // PB +2
      weapon: { damage: '1d8', properties: ['Versatile'], category: 'Martial Melee' },
    });
    expect(p).toEqual({ attackBonus: 5, damageDice: '1d8', damageMod: 3 });
  });

  it('finesse weapon: best of STR/DEX', () => {
    const p = buildPcAttackProfile({
      abilities: { STR: 8, DEX: 18 }, // -1 / +4
      level: 1,
      weapon: { damage: '1d8', properties: ['Finesse'], category: 'Martial Melee' },
    });
    expect(p).toEqual({ attackBonus: 6, damageDice: '1d8', damageMod: 4 });
  });

  it('ranged weapon: DEX regardless of STR', () => {
    const p = buildPcAttackProfile({
      abilities: { STR: 18, DEX: 12 }, // +4 / +1
      level: 1,
      weapon: { damage: '1d8', properties: ['Ammunition'], category: 'Martial Ranged' },
    });
    expect(p).toEqual({ attackBonus: 3, damageDice: '1d8', damageMod: 1 });
  });

  it('PB scales with level (rules.md §1.4): level 5 → +3, level 9 → +4', () => {
    const w = { damage: '2d6', properties: [], category: 'Martial Melee' };
    expect(buildPcAttackProfile({ abilities, level: 5, weapon: w })!.attackBonus).toBe(6);
    expect(buildPcAttackProfile({ abilities, level: 9, weapon: w })!.attackBonus).toBe(7);
    // damage mod NEVER includes PB at any level
    expect(buildPcAttackProfile({ abilities, level: 9, weapon: w })!.damageMod).toBe(3);
  });

  it('strips flat parts from the dice term and normalizes the count', () => {
    const p = buildPcAttackProfile({
      abilities,
      level: 1,
      weapon: { damage: 'd6', properties: [], category: 'Simple Melee' },
    });
    expect(p!.damageDice).toBe('1d6');
  });

  it('returns null without a weapon or with a non-dice damage entry', () => {
    expect(buildPcAttackProfile({ abilities, level: 1, weapon: null })).toBeNull();
    expect(buildPcAttackProfile({
      abilities,
      level: 1,
      weapon: { damage: '—', properties: [], category: 'Martial Ranged' },
    })).toBeNull();
  });

  it('negative ability mod produces a negative damage mod (RAW)', () => {
    const p = buildPcAttackProfile({
      abilities: { STR: 6, DEX: 8 }, // -2 / -1
      level: 1,
      weapon: { damage: '1d6', properties: [], category: 'Simple Melee' },
    });
    expect(p).toEqual({ attackBonus: 0, damageDice: '1d6', damageMod: -2 });
  });
});
