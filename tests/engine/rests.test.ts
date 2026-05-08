import { describe, it, expect } from 'vitest';
import { shortRest, longRest } from '@/engine/rests';
import { makeSeededRng } from '@/engine/rand';
import type { Character, ActorRuntimeState } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null,
  features: [
    { slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second wind' },
    { slug: 'action_surge', source: 'class', usesMax: 1, description: 'Action surge' },
  ],
  inventory: [], hitDiceMax: 5, hitDieSize: 10,
};

const fighterRuntime: ActorRuntimeState = {
  actorId: 'pc1', hpCurrent: 20, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [],
  hitDiceRemaining: 3, resourcesUsed: { second_wind: 1, action_surge: 1 }, spellSlotsUsed: {},
};

describe('shortRest', () => {
  it('spending hit dice rolls them and heals up to hpMax', () => {
    const r = shortRest({ char: fighter, runtime: fighterRuntime, hitDiceSpent: 2 }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.rolls.length).toBe(2);
    const healMut = r.mutations.find((m) => m.op === 'heal');
    expect(healMut).toBeDefined();
    expect(r.mutations.filter((m) => m.op === 'spend_hit_die').length).toBe(2);
  });

  it('refuses if not enough hit dice remaining', () => {
    const noDice: ActorRuntimeState = { ...fighterRuntime, hitDiceRemaining: 1 };
    const r = shortRest({ char: fighter, runtime: noDice, hitDiceSpent: 2 }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_enough_hit_dice');
  });

  it('does NOT restore long-rest-only resources (action_surge)', () => {
    const r = shortRest({ char: fighter, runtime: fighterRuntime, hitDiceSpent: 0 }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    // second_wind restores; action_surge does not (long-rest only)
    const restoresOf = (slug: string) => r.mutations.filter((m) => m.op === 'restore_resource' && (m as { featureSlug: string }).featureSlug === slug);
    expect(restoresOf('second_wind').length).toBe(1);
    expect(restoresOf('action_surge').length).toBe(0);
  });
});

describe('longRest', () => {
  it('restores full HP, all hit dice (max half hpMax of dice), all slots, all resources', () => {
    const r = longRest({ char: fighter, runtime: fighterRuntime });
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp' && (m as { hpCurrent: number }).hpCurrent === fighter.hpMax)).toBe(true);
    expect(r.mutations.filter((m) => m.op === 'restore_resource').length).toBe(2);
    // restore_hit_dice up to half of hitDiceMax
    expect(r.mutations.some((m) => m.op === 'restore_hit_dice')).toBe(true);
  });

  it('emits one restore_spell_slot per used slot level (carrying the used count)', () => {
    const wizard: Character = {
      ...fighter,
      classSlug: 'wizard',
      spellcasting: {
        ability: 'INT',
        spellSaveDC: 13,
        spellAttackBonus: 5,
        slotsMax: { 1: 4, 2: 3, 3: 2 },
        spellsKnown: [],
        spellsPrepared: [],
      },
    };
    const wizardRuntime: ActorRuntimeState = {
      ...fighterRuntime,
      spellSlotsUsed: { 1: 3, 2: 0, 3: 2 },
    };
    const r = longRest({ char: wizard, runtime: wizardRuntime });
    expect(r.ok).toBe(true);
    const restores = r.mutations.filter((m) => m.op === 'restore_spell_slot') as Array<
      { op: 'restore_spell_slot'; level: number; amount: number }
    >;
    // Only levels with usedCount > 0 emit a mutation (level 2 is skipped).
    expect(restores).toHaveLength(2);
    expect(restores.find((m) => m.level === 1)?.amount).toBe(3);
    expect(restores.find((m) => m.level === 3)?.amount).toBe(2);
    expect(restores.find((m) => m.level === 2)).toBeUndefined();
  });

  it('emits no restore_spell_slot when no slots are used', () => {
    const wizardFull: ActorRuntimeState = { ...fighterRuntime, spellSlotsUsed: { 1: 0, 2: 0 } };
    const r = longRest({ char: fighter, runtime: wizardFull });
    expect(r.mutations.some((m) => m.op === 'restore_spell_slot')).toBe(false);
  });
});
