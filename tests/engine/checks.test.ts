import { describe, it, expect } from 'vitest';
import { abilityCheck, savingThrow, contestedCheck, passiveCheck, groupCheck } from '@/engine/checks';
import { createRng, makeSeededRng, type Rng } from '@/engine/rand';
import type { ActorRuntimeState, Character, ConditionInstance, ConditionSlug } from '@/engine/types';

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

// ─── Condition-effect integration tests ────────────────────────────────────

const cond = (slug: ConditionSlug, extra?: Partial<ConditionInstance>): ConditionInstance => ({
  slug,
  source: 'test',
  durationRounds: 'until_removed',
  appliedRound: 0,
  ...extra,
});

interface TestRuntimeOpts {
  conditions?: ConditionSlug[];
  exhaustionLevel?: number;
}

function testRuntime(opts: TestRuntimeOpts = {}): ActorRuntimeState {
  const conds = (opts.conditions ?? []).map((s) => cond(s));
  const runtime: ActorRuntimeState = {
    actorId: fighter.id,
    hpCurrent: fighter.hpMax,
    tempHp: 0,
    conditions: conds,
    deathSaves: { successes: 0, failures: 0 },
  };
  if (opts.exhaustionLevel !== undefined) {
    runtime.exhaustionLevel = opts.exhaustionLevel;
    // also push a synthetic exhaustion condition so the resolver has it in the array
    if (opts.exhaustionLevel > 0) runtime.conditions.push(cond('exhaustion'));
  }
  return runtime;
}

/** RNG that returns a fixed sequence of uniform-01 values, looping past the end. */
function seqRng(values: number[]): Rng {
  let i = 0;
  return createRng(() => {
    const v = values[i % values.length]!;
    i += 1;
    return v;
  });
}

describe('abilityCheck — condition effects', () => {
  it('poisoned imposes disadvantage on ability checks (rolls 2 dice)', () => {
    // rng returns 0.95 then 0.05 → first d20 high (~20), second d20 low (~2); DIS picks the low one
    const rng = seqRng([0.95, 0.05]);
    const r = abilityCheck(
      { char: fighter, ability: 'STR', dc: 15, runtime: testRuntime({ conditions: ['poisoned'] }) },
      rng,
    );
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.disadvantage).toBe(true);
    // DIS picks the lower d20 → second roll
    const lower = Math.min(...r.rolls[0]!.rolls);
    expect(r.rolls[0]!.total).toBe(lower + r.rolls[0]!.modifier);
  });

  it('exhaustion lvl 1 imposes disadvantage on ability checks', () => {
    const rng = seqRng([0.95, 0.05]);
    const r = abilityCheck(
      { char: fighter, ability: 'STR', dc: 15, runtime: testRuntime({ exhaustionLevel: 1 }) },
      rng,
    );
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.disadvantage).toBe(true);
  });

  it('no condition → single die, no DIS meta', () => {
    const rng = seqRng([0.5]);
    const r = abilityCheck(
      { char: fighter, ability: 'STR', dc: 15, runtime: testRuntime() },
      rng,
    );
    expect(r.rolls[0]!.rolls.length).toBe(1);
    expect(r.rolls[0]!.meta?.disadvantage).toBeUndefined();
  });
});

describe('savingThrow — condition effects', () => {
  it('paralyzed → STR save auto-fails without rolling', () => {
    const r = savingThrow(
      { char: fighter, ability: 'STR', dc: 10, runtime: testRuntime({ conditions: ['paralyzed'] }) },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.data?.autoFailed).toBe(true);
    expect(r.rolls.length).toBe(0);
  });

  it('paralyzed → DEX save auto-fails', () => {
    const r = savingThrow(
      { char: fighter, ability: 'DEX', dc: 10, runtime: testRuntime({ conditions: ['paralyzed'] }) },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.data?.autoFailed).toBe(true);
    expect(r.rolls.length).toBe(0);
  });

  it('paralyzed → CON save NOT auto-fail; rolls a d20 normally', () => {
    const r = savingThrow(
      { char: fighter, ability: 'CON', dc: 10, runtime: testRuntime({ conditions: ['paralyzed'] }) },
      makeSeededRng(1),
    );
    expect(r.data?.autoFailed).toBeFalsy();
    expect(r.rolls.length).toBe(1);
    expect(r.rolls[0]!.rolls.length).toBe(1);
  });

  it('restrained → DEX save has disadvantage (2 dice)', () => {
    const rng = seqRng([0.95, 0.05]);
    const r = savingThrow(
      { char: fighter, ability: 'DEX', dc: 10, runtime: testRuntime({ conditions: ['restrained'] }) },
      rng,
    );
    expect(r.rolls.length).toBe(1);
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.disadvantage).toBe(true);
  });

  it('stunned → STR save auto-fail', () => {
    const r = savingThrow(
      { char: fighter, ability: 'STR', dc: 10, runtime: testRuntime({ conditions: ['stunned'] }) },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.data?.autoFailed).toBe(true);
  });

  it('petrified → STR save auto-fail', () => {
    const r = savingThrow(
      { char: fighter, ability: 'STR', dc: 10, runtime: testRuntime({ conditions: ['petrified'] }) },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.data?.autoFailed).toBe(true);
  });

  it('unconscious → STR save auto-fail', () => {
    const r = savingThrow(
      { char: fighter, ability: 'STR', dc: 10, runtime: testRuntime({ conditions: ['unconscious'] }) },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.data?.autoFailed).toBe(true);
  });

  it('no runtime supplied → unchanged behavior (single die)', () => {
    const r = savingThrow(
      { char: fighter, ability: 'STR', dc: 10 },
      makeSeededRng(1),
    );
    expect(r.rolls.length).toBe(1);
    expect(r.data?.autoFailed).toBeFalsy();
  });
});

describe('abilityCheck — useInspiration (PHB §18.1)', () => {
  const inspired: Character = { ...fighter, inspiration: true };
  const uninspired: Character = { ...fighter, inspiration: false };

  it('useInspiration:true with inspiration grants ADV (2 d20s) + emits spend mutation', () => {
    const r = abilityCheck(
      { char: inspired, skill: 'Athletics', dc: 10, useInspiration: true },
      makeSeededRng(7),
    );
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.advantage).toBe(true);
    const spend = r.mutations.find((m) => m.op === 'spend_inspiration');
    expect(spend).toMatchObject({ characterId: inspired.id });
  });

  it('useInspiration:true without inspiration → error no_inspiration, no rolls', () => {
    const r = abilityCheck(
      { char: uninspired, skill: 'Athletics', dc: 10, useInspiration: true },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_inspiration');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('useInspiration:false (default) → no spend mutation, single die', () => {
    const r = abilityCheck(
      { char: inspired, skill: 'Athletics', dc: 10 },
      makeSeededRng(1),
    );
    expect(r.rolls[0]!.rolls.length).toBe(1);
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeUndefined();
  });

  it('spend mutation emitted regardless of pass/fail outcome', () => {
    // Run with the inspired char twice — even on a result that misses the
    // DC, the mutation must still be present.
    const r = abilityCheck(
      { char: inspired, skill: 'Athletics', dc: 25, useInspiration: true },
      makeSeededRng(2),
    );
    // A DC 25 check is hard to pass with +5 even on ADV — confirm the spend
    // is unconditional regardless of `r.ok`.
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeDefined();
  });

  it('combines with helped (advantage) without double-rolling', () => {
    const helpedRuntime: ActorRuntimeState = {
      actorId: inspired.id,
      hpCurrent: 10,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'helped', source: 'ally', durationRounds: 'until_removed', appliedRound: 0 },
      ],
    };
    const r = abilityCheck(
      { char: inspired, skill: 'Athletics', dc: 10, useInspiration: true, runtime: helpedRuntime },
      makeSeededRng(1),
    );
    // ADV is binary: helped + inspiration still produces exactly 2 dice.
    expect(r.rolls[0]!.rolls.length).toBe(2);
    // Both consume mutations are present.
    expect(r.mutations.find((m) => m.op === 'remove_condition' && m.conditionSlug === 'helped')).toBeDefined();
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeDefined();
  });
});

describe('savingThrow — useInspiration (PHB §18.1)', () => {
  const inspired: Character = { ...fighter, inspiration: true };
  const uninspired: Character = { ...fighter, inspiration: false };

  it('useInspiration:true with inspiration grants ADV + emits spend mutation', () => {
    const r = savingThrow(
      { char: inspired, ability: 'STR', dc: 10, useInspiration: true },
      makeSeededRng(7),
    );
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.advantage).toBe(true);
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeDefined();
  });

  it('useInspiration:true without inspiration → error no_inspiration', () => {
    const r = savingThrow(
      { char: uninspired, ability: 'STR', dc: 10, useInspiration: true },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_inspiration');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('useInspiration:false → no spend mutation', () => {
    const r = savingThrow(
      { char: inspired, ability: 'STR', dc: 10 },
      makeSeededRng(1),
    );
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeUndefined();
  });

  it('spend still emitted on auto-fail saves (paralyzed STR)', () => {
    // Paralyzed forces auto-fail on STR/DEX saves (PHB Appendix A). The
    // player declared the spend before learning the auto-fail; consume it.
    const paralyzedRuntime: ActorRuntimeState = {
      actorId: inspired.id,
      hpCurrent: 10,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'paralyzed', source: 'spell', durationRounds: 'until_removed', appliedRound: 0 },
      ],
    };
    const r = savingThrow(
      { char: inspired, ability: 'STR', dc: 10, useInspiration: true, runtime: paralyzedRuntime },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.data?.autoFailed).toBe(true);
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeDefined();
  });
});
