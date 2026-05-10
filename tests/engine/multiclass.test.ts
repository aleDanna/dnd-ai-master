import { describe, it, expect } from 'vitest';
import {
  CASTER_TYPE,
  MULTICLASS_PREREQS,
  combinedCasterLevel,
  meetsMulticlassPrereqs,
  spellSlotsForCasterLevel,
  VALID_CLASS_SLUGS,
} from '@/engine/multiclass';
import type { Character } from '@/engine/types';

/**
 * Build a minimal Character fixture for prereq tests. Caller overrides
 * abilities + classSlug + classes as needed; everything else is stub.
 */
function makeCharacter(overrides: Partial<Character>): Character {
  return {
    id: 'pc1',
    name: 'Test PC',
    level: 1,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: 2,
    hpMax: 10,
    ac: 10,
    speed: 30,
    proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 1,
    hitDieSize: 8,
    ...overrides,
  };
}

describe('MULTICLASS_PREREQS (PHB §2.5)', () => {
  it('lists the canonical 12 PHB classes', () => {
    expect(VALID_CLASS_SLUGS).toEqual(
      expect.arrayContaining([
        'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
        'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
      ]),
    );
    expect(VALID_CLASS_SLUGS).toHaveLength(12);
  });

  it('Barbarian: STR 13', () => {
    expect(MULTICLASS_PREREQS.barbarian).toEqual({ mode: 'and', mins: { STR: 13 } });
  });
  it('Bard: CHA 13', () => {
    expect(MULTICLASS_PREREQS.bard).toEqual({ mode: 'and', mins: { CHA: 13 } });
  });
  it('Cleric: WIS 13', () => {
    expect(MULTICLASS_PREREQS.cleric).toEqual({ mode: 'and', mins: { WIS: 13 } });
  });
  it('Druid: WIS 13', () => {
    expect(MULTICLASS_PREREQS.druid).toEqual({ mode: 'and', mins: { WIS: 13 } });
  });
  it('Fighter: STR 13 OR DEX 13', () => {
    expect(MULTICLASS_PREREQS.fighter).toEqual({ mode: 'or', mins: { STR: 13, DEX: 13 } });
  });
  it('Monk: DEX 13 AND WIS 13', () => {
    expect(MULTICLASS_PREREQS.monk).toEqual({ mode: 'and', mins: { DEX: 13, WIS: 13 } });
  });
  it('Paladin: STR 13 AND CHA 13', () => {
    expect(MULTICLASS_PREREQS.paladin).toEqual({ mode: 'and', mins: { STR: 13, CHA: 13 } });
  });
  it('Ranger: DEX 13 AND WIS 13', () => {
    expect(MULTICLASS_PREREQS.ranger).toEqual({ mode: 'and', mins: { DEX: 13, WIS: 13 } });
  });
  it('Rogue: DEX 13', () => {
    expect(MULTICLASS_PREREQS.rogue).toEqual({ mode: 'and', mins: { DEX: 13 } });
  });
  it('Sorcerer: CHA 13', () => {
    expect(MULTICLASS_PREREQS.sorcerer).toEqual({ mode: 'and', mins: { CHA: 13 } });
  });
  it('Warlock: CHA 13', () => {
    expect(MULTICLASS_PREREQS.warlock).toEqual({ mode: 'and', mins: { CHA: 13 } });
  });
  it('Wizard: INT 13', () => {
    expect(MULTICLASS_PREREQS.wizard).toEqual({ mode: 'and', mins: { INT: 13 } });
  });
});

describe('meetsMulticlassPrereqs', () => {
  it('returns true for re-leveling the existing starting class (no prereq check)', () => {
    // Fighter with STR 8 (below the OR threshold) — re-leveling fighter is a
    // no-prereq event, even when the starting check would otherwise fail.
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 8, DEX: 8, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'fighter')).toBe(true);
  });

  it('returns true for re-leveling a non-starting existing multi-class entry', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [
        { slug: 'fighter', level: 3 },
        { slug: 'wizard', level: 2 },
      ],
      abilities: { STR: 8, DEX: 8, CON: 10, INT: 8, WIS: 10, CHA: 10 },
    });
    // Re-level wizard: no check, even though INT < 13.
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(true);
  });

  it('Fighter STR 16 INT 10 → adding Wizard: fails (INT < 13)', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(false);
  });

  it('Fighter STR 16 INT 13 → adding Wizard: succeeds', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(true);
  });

  it('Fighter STR 8 DEX 16 INT 13 → adding Wizard: succeeds via fighter OR-mode (DEX 13)', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 8, DEX: 16, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(true);
  });

  it('Fighter STR 8 DEX 8 INT 13 → adding Wizard: fails (fighter OR-mode needs STR or DEX 13)', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 8, DEX: 8, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(false);
  });

  it('Monk AND-mode: DEX 13 alone insufficient — needs both DEX 13 AND WIS 13', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 13, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'monk')).toBe(false);
  });

  it('Monk AND-mode: DEX 13 AND WIS 13 satisfies monk side', () => {
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 13, CON: 14, INT: 10, WIS: 13, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(char, 'monk')).toBe(true);
  });

  it('Paladin AND-mode: requires STR 13 AND CHA 13', () => {
    const ok = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 13, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 13 },
    });
    expect(meetsMulticlassPrereqs(ok, 'paladin')).toBe(true);

    const noChaPaladin = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 13, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(noChaPaladin, 'paladin')).toBe(false);
  });

  it('Ranger AND-mode: requires DEX 13 AND WIS 13', () => {
    const noWisRanger = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 13, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(noWisRanger, 'ranger')).toBe(false);
  });

  it('Barbarian: requires STR 13 (single-stat AND mode)', () => {
    const ok = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 13, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(ok, 'barbarian')).toBe(true);

    const fail = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 12, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(fail, 'barbarian')).toBe(false);
  });

  it('Bard, Sorcerer, Warlock all require CHA 13', () => {
    const cha13 = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 13 },
    });
    expect(meetsMulticlassPrereqs(cha13, 'bard')).toBe(true);
    expect(meetsMulticlassPrereqs(cha13, 'sorcerer')).toBe(true);
    expect(meetsMulticlassPrereqs(cha13, 'warlock')).toBe(true);

    const cha10 = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(cha10, 'bard')).toBe(false);
    expect(meetsMulticlassPrereqs(cha10, 'sorcerer')).toBe(false);
    expect(meetsMulticlassPrereqs(cha10, 'warlock')).toBe(false);
  });

  it('Cleric, Druid require WIS 13', () => {
    const wis13 = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 13, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(wis13, 'cleric')).toBe(true);
    expect(meetsMulticlassPrereqs(wis13, 'druid')).toBe(true);
  });

  it('Rogue requires DEX 13 (single-stat AND mode)', () => {
    const dex13 = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 13, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(dex13, 'rogue')).toBe(true);

    const dex12 = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(dex12, 'rogue')).toBe(false);
  });

  it('Wizard requires INT 13', () => {
    const int13 = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(int13, 'wizard')).toBe(true);
  });

  it('Sorcerer (CHA 13 starter) → adding Wizard requires both CHA 13 AND INT 13', () => {
    const sorcOk = makeCharacter({
      classSlug: 'sorcerer',
      classes: [{ slug: 'sorcerer', level: 3 }],
      abilities: { STR: 8, DEX: 12, CON: 14, INT: 13, WIS: 10, CHA: 16 },
    });
    expect(meetsMulticlassPrereqs(sorcOk, 'wizard')).toBe(true);

    // Sorcerer with INT 10 → can't add Wizard.
    const sorcNoInt = makeCharacter({
      classSlug: 'sorcerer',
      classes: [{ slug: 'sorcerer', level: 3 }],
      abilities: { STR: 8, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 16 },
    });
    expect(meetsMulticlassPrereqs(sorcNoInt, 'wizard')).toBe(false);

    // Sorcerer's starting CHA below 13 → can't add Wizard even with INT 13.
    const sorcNoStart = makeCharacter({
      classSlug: 'sorcerer',
      classes: [{ slug: 'sorcerer', level: 3 }],
      abilities: { STR: 8, DEX: 12, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    expect(meetsMulticlassPrereqs(sorcNoStart, 'wizard')).toBe(false);
  });

  it('legacy character with no `classes` field still validates against `classSlug`', () => {
    // No classes[] — meetsMulticlassPrereqs falls back to classSlug.
    const char = makeCharacter({
      classSlug: 'wizard',
      abilities: { STR: 8, DEX: 12, CON: 14, INT: 16, WIS: 10, CHA: 13 },
    });
    expect(meetsMulticlassPrereqs(char, 'sorcerer')).toBe(true);
    // Adding the same class as the legacy starter (re-level): no check.
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(true);
  });

  it('unknown class slug imposes no constraint on its own side (validation is the tool layer\'s job)', () => {
    // The starting fighter side still validates (STR/DEX 13 OR-mode), but
    // the unknown new-class side passes through with no check.
    const char = makeCharacter({
      classSlug: 'fighter',
      classes: [{ slug: 'fighter', level: 3 }],
      abilities: { STR: 13, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 },
    });
    expect(meetsMulticlassPrereqs(char, 'unknown-homebrew')).toBe(true);
  });

  it('unknown starting class slug imposes no starting-side constraint', () => {
    const char = makeCharacter({
      classSlug: 'unknown-homebrew',
      classes: [{ slug: 'unknown-homebrew', level: 3 }],
      abilities: { STR: 8, DEX: 8, CON: 8, INT: 13, WIS: 8, CHA: 8 },
    });
    // Adding wizard: starting side is 'unknown' (no constraint), new side is wizard (INT 13). Pass.
    expect(meetsMulticlassPrereqs(char, 'wizard')).toBe(true);
  });
});

describe('combinedCasterLevel (PHB §13.2)', () => {
  it('full caster only: caster level = sum of class levels', () => {
    expect(combinedCasterLevel([{ slug: 'wizard', level: 5 }])).toBe(5);
    expect(combinedCasterLevel([{ slug: 'bard', level: 7 }])).toBe(7);
    expect(combinedCasterLevel([{ slug: 'sorcerer', level: 1 }])).toBe(1);
  });

  it('multi-full-caster: bard 5 + wizard 5 = 10', () => {
    expect(
      combinedCasterLevel([
        { slug: 'bard', level: 5 },
        { slug: 'wizard', level: 5 },
      ]),
    ).toBe(10);
  });

  it('half caster paladin/ranger: floor(level/2); level 1 contributes 0', () => {
    expect(combinedCasterLevel([{ slug: 'paladin', level: 1 }])).toBe(0);
    expect(combinedCasterLevel([{ slug: 'paladin', level: 2 }])).toBe(1);
    expect(combinedCasterLevel([{ slug: 'paladin', level: 5 }])).toBe(2);
    expect(combinedCasterLevel([{ slug: 'ranger', level: 1 }])).toBe(0);
    expect(combinedCasterLevel([{ slug: 'ranger', level: 2 }])).toBe(1);
    expect(combinedCasterLevel([{ slug: 'ranger', level: 11 }])).toBe(5);
  });

  it('half caster + full caster: paladin 5 + wizard 5 = floor(5/2) + 5 = 7', () => {
    expect(
      combinedCasterLevel([
        { slug: 'paladin', level: 5 },
        { slug: 'wizard', level: 5 },
      ]),
    ).toBe(7);
  });

  it('Eldritch Knight (third-caster subclass): contributes floor(level/3); 0 below L3', () => {
    expect(combinedCasterLevel([{ slug: 'fighter', level: 2, subclass: 'eldritch-knight' }])).toBe(0);
    expect(combinedCasterLevel([{ slug: 'fighter', level: 3, subclass: 'eldritch-knight' }])).toBe(1);
    expect(combinedCasterLevel([{ slug: 'fighter', level: 9, subclass: 'eldritch-knight' }])).toBe(3);
  });

  it('Arcane Trickster (third-caster subclass): contributes floor(level/3); 0 below L3', () => {
    expect(combinedCasterLevel([{ slug: 'rogue', level: 2, subclass: 'arcane-trickster' }])).toBe(0);
    expect(combinedCasterLevel([{ slug: 'rogue', level: 3, subclass: 'arcane-trickster' }])).toBe(1);
    expect(combinedCasterLevel([{ slug: 'rogue', level: 9, subclass: 'arcane-trickster' }])).toBe(3);
  });

  it('Eldritch Knight 5 + wizard 5 = floor(5/3) + 5 = 1 + 5 = 6', () => {
    expect(
      combinedCasterLevel([
        { slug: 'fighter', level: 5, subclass: 'eldritch-knight' },
        { slug: 'wizard', level: 5 },
      ]),
    ).toBe(6);
  });

  it('plain fighter / rogue (no subclass) contributes 0', () => {
    expect(combinedCasterLevel([{ slug: 'fighter', level: 5 }])).toBe(0);
    expect(combinedCasterLevel([{ slug: 'rogue', level: 5 }])).toBe(0);
  });

  it('plain fighter (no subclass) + wizard 5 = 5 (fighter contributes 0)', () => {
    expect(
      combinedCasterLevel([
        { slug: 'fighter', level: 5 },
        { slug: 'wizard', level: 5 },
      ]),
    ).toBe(5);
  });

  it('warlock contributes 0 (Pact Magic separate from multi-class slots)', () => {
    expect(combinedCasterLevel([{ slug: 'warlock', level: 5 }])).toBe(0);
    expect(
      combinedCasterLevel([
        { slug: 'warlock', level: 5 },
        { slug: 'wizard', level: 5 },
      ]),
    ).toBe(5);
  });

  it('non-caster class barbarian/monk contributes 0', () => {
    expect(combinedCasterLevel([{ slug: 'barbarian', level: 5 }])).toBe(0);
    expect(combinedCasterLevel([{ slug: 'monk', level: 5 }])).toBe(0);
  });

  it('empty class array returns 0', () => {
    expect(combinedCasterLevel([])).toBe(0);
  });
});

describe('CASTER_TYPE', () => {
  it('classifies the canonical 12 PHB classes', () => {
    expect(CASTER_TYPE.bard).toBe('full');
    expect(CASTER_TYPE.cleric).toBe('full');
    expect(CASTER_TYPE.druid).toBe('full');
    expect(CASTER_TYPE.sorcerer).toBe('full');
    expect(CASTER_TYPE.wizard).toBe('full');
    expect(CASTER_TYPE.paladin).toBe('half');
    expect(CASTER_TYPE.ranger).toBe('half');
    expect(CASTER_TYPE.fighter).toBe('none');
    expect(CASTER_TYPE.rogue).toBe('none');
    expect(CASTER_TYPE.monk).toBe('none');
    expect(CASTER_TYPE.barbarian).toBe('none');
    expect(CASTER_TYPE.warlock).toBe('pact');
  });
});

describe('spellSlotsForCasterLevel (PHB §13.1)', () => {
  it('returns empty for caster level 0 / negative / NaN', () => {
    expect(spellSlotsForCasterLevel(0)).toEqual({});
    expect(spellSlotsForCasterLevel(-1)).toEqual({});
    expect(spellSlotsForCasterLevel(NaN)).toEqual({});
  });

  it('level 1: 2 first-level slots', () => {
    expect(spellSlotsForCasterLevel(1)).toEqual({ 1: 2 });
  });
  it('level 2: 3 first-level slots', () => {
    expect(spellSlotsForCasterLevel(2)).toEqual({ 1: 3 });
  });
  it('level 3: 4 first + 2 second', () => {
    expect(spellSlotsForCasterLevel(3)).toEqual({ 1: 4, 2: 2 });
  });
  it('level 4', () => {
    expect(spellSlotsForCasterLevel(4)).toEqual({ 1: 4, 2: 3 });
  });
  it('level 5: 4/3/2', () => {
    expect(spellSlotsForCasterLevel(5)).toEqual({ 1: 4, 2: 3, 3: 2 });
  });
  it('level 6', () => {
    expect(spellSlotsForCasterLevel(6)).toEqual({ 1: 4, 2: 3, 3: 3 });
  });
  it('level 7: opens 4th-level slots (1)', () => {
    expect(spellSlotsForCasterLevel(7)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 1 });
  });
  it('level 8', () => {
    expect(spellSlotsForCasterLevel(8)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 2 });
  });
  it('level 9: opens 5th-level slots (1)', () => {
    expect(spellSlotsForCasterLevel(9)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 });
  });
  it('level 10', () => {
    expect(spellSlotsForCasterLevel(10)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 });
  });
  it('level 11: opens 6th-level slot (1)', () => {
    expect(spellSlotsForCasterLevel(11)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 });
  });
  it('level 12 same as 11', () => {
    expect(spellSlotsForCasterLevel(12)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 });
  });
  it('level 13: opens 7th-level slot (1)', () => {
    expect(spellSlotsForCasterLevel(13)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 });
  });
  it('level 14 same as 13', () => {
    expect(spellSlotsForCasterLevel(14)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 });
  });
  it('level 15: opens 8th-level slot (1)', () => {
    expect(spellSlotsForCasterLevel(15)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 });
  });
  it('level 16 same as 15', () => {
    expect(spellSlotsForCasterLevel(16)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 });
  });
  it('level 17: opens 9th-level slot (1)', () => {
    expect(spellSlotsForCasterLevel(17)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 });
  });
  it('level 18: 5th-level slot scales up to 3', () => {
    expect(spellSlotsForCasterLevel(18)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 });
  });
  it('level 19: 6th-level slot scales up to 2', () => {
    expect(spellSlotsForCasterLevel(19)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 });
  });
  it('level 20: 7th-level slot scales up to 2', () => {
    expect(spellSlotsForCasterLevel(20)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 });
  });
  it('level >20 clamps to level 20', () => {
    expect(spellSlotsForCasterLevel(21)).toEqual(spellSlotsForCasterLevel(20));
    expect(spellSlotsForCasterLevel(99)).toEqual(spellSlotsForCasterLevel(20));
  });
});
