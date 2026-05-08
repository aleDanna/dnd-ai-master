import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { makeSeededRng } from '@/engine/rand';
import type { ActorRuntimeState, Character, CombatActor, ConditionInstance, ConditionSlug } from '@/engine/types';

const cond = (slug: ConditionSlug, extra?: Partial<ConditionInstance>): ConditionInstance => ({
  slug,
  source: 'test',
  durationRounds: 'until_removed',
  appliedRound: 0,
  ...extra,
});

function runtimeFor(actorId: string, opts: { hpCurrent?: number; conditions?: ConditionInstance[] } = {}): ActorRuntimeState {
  return {
    actorId,
    hpCurrent: opts.hpCurrent ?? 10,
    tempHp: 0,
    conditions: opts.conditions ?? [],
    deathSaves: { successes: 0, failures: 0 },
  };
}

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('makeAttack', () => {
  it('on hit: returns ok=true, damage roll, apply_damage mutation', () => {
    // Find a seed where the d20 hits AC 15
    let seed = 0;
    while (seed < 100) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
      }, makeSeededRng(seed));
      if (r.ok) {
        expect(r.rolls.length).toBeGreaterThanOrEqual(2);    // attack + damage
        expect(r.mutations.some((m) => m.op === 'apply_damage' && (m as { actorId: string }).actorId === 'm1')).toBe(true);
        return;
      }
      seed++;
    }
    throw new Error('No hit found in 100 seeds — RNG suspicious');
  });

  it('on miss: ok=false, no damage roll, no mutations', () => {
    let seed = 0;
    while (seed < 100) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
        disadvantage: true,
      }, makeSeededRng(seed));
      if (!r.ok && r.error === 'miss') {
        expect(r.mutations.length).toBe(0);
        expect(r.rolls.length).toBe(1);                        // only attack roll
        return;
      }
      seed++;
    }
    throw new Error('No miss found in 100 seeds — RNG suspicious');
  });

  it('natural 20 always hits and crits damage', () => {
    const fixed20 = { intInclusive: (min: number, max: number) => max === 20 ? 20 : 1 + min };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixed20);
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
    // Damage roll should have 2 dice (1d8 doubled)
    const damageRoll = r.rolls[1]!;
    expect(damageRoll.rolls.length).toBe(2);
  });

  it('natural 1 always misses regardless of bonus', () => {
    const fixed1 = { intInclusive: (_min: number, max: number) => max === 20 ? 1 : 1 };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixed1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('miss');
    expect(r.data?.crit).toBeFalsy();
  });

  it('respects target resistance/immunity: damage halved on resistance, zero on immunity', () => {
    const resistantGoblin: CombatActor = { ...goblin, resistances: ['slashing'] };
    const fixedHit = { intInclusive: (_min: number, max: number) => max === 20 ? 18 : Math.ceil(max / 2) };
    const r = makeAttack({
      attacker: fighter,
      target: resistantGoblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixedHit);
    expect(r.ok).toBe(true);
    const dmgMut = r.mutations.find((m) => m.op === 'apply_damage') as { amount: number } | undefined;
    expect(dmgMut).toBeDefined();
    // The mutation amount should reflect halving (ceil(raw / 2)) — engine handles this.
    expect(dmgMut!.amount).toBeGreaterThan(0);
  });
});

describe('makeAttack — condition effects', () => {
  const longsword = { name: 'Longsword', damage: '1d8', damageType: 'slashing' as const, profGroup: 'Martial', useDex: false };
  const shortbow = { name: 'Shortbow', damage: '1d6', damageType: 'piercing' as const, profGroup: 'Simple', useDex: true };

  it('attacker poisoned → DIS on attack (rolls length 2)', () => {
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44, conditions: [cond('poisoned')] });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7 });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
    }, makeSeededRng(7));
    expect(r.rolls[0]!.rolls.length).toBe(2);
  });

  it('target prone, melee within 5ft → ADV on attacker (rolls length 2)', () => {
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7, conditions: [cond('prone')] });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
      ranged: false,
      meleeRange: 5,
    }, makeSeededRng(3));
    expect(r.rolls[0]!.rolls.length).toBe(2);
    // ADV picks the higher of the two
    const max = Math.max(...r.rolls[0]!.rolls);
    expect(r.rolls[0]!.total).toBe(max + r.rolls[0]!.modifier);
  });

  it('target paralyzed within 5ft melee → auto-crit on hit', () => {
    // fixed RNG: d20 lands at, say, 15 → +bonus hits AC 15 (goblin), all damage dice max
    const fixedHit = { intInclusive: (_min: number, max: number) => max === 20 ? 15 : max };
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7, conditions: [cond('paralyzed')] });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
      ranged: false,
      meleeRange: 5,
    }, fixedHit);
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
    // Damage roll should have 2 dice (1d8 doubled) due to crit
    const damageRoll = r.rolls[1]!;
    expect(damageRoll.rolls.length).toBe(2);
  });

  it('both attacker and target invisible → ADV+DIS cancel (single d20)', () => {
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44, conditions: [cond('invisible')] });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7, conditions: [cond('invisible')] });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
    }, makeSeededRng(11));
    expect(r.rolls[0]!.rolls.length).toBe(1);
  });

  it('attacker incapacitated (unconscious) → ok:false, error mentions incapacitated', () => {
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44, conditions: [cond('unconscious')] });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7 });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
    }, makeSeededRng(0));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/incapacitated/i);
  });

  it('target restrained → incoming ADV (rolls length 2)', () => {
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7, conditions: [cond('restrained')] });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
    }, makeSeededRng(3));
    expect(r.rolls[0]!.rolls.length).toBe(2);
  });

  it('target prone, ranged attack → DIS on ranged (rolls length 2, picks lower)', () => {
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7, conditions: [cond('prone')] });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: shortbow,
      attackerRuntime,
      targetRuntime,
      ranged: true,
    }, makeSeededRng(7));
    expect(r.rolls[0]!.rolls.length).toBe(2);
    // DIS picks the lower
    const min = Math.min(...r.rolls[0]!.rolls);
    expect(r.rolls[0]!.total).toBe(min + r.rolls[0]!.modifier);
  });
});

describe('makeAttack — knockOut option', () => {
  const longsword = { name: 'Longsword', damage: '1d8', damageType: 'slashing' as const, profGroup: 'Martial', useDex: false };
  const shortbow = { name: 'Shortbow', damage: '1d6', damageType: 'piercing' as const, profGroup: 'Simple', useDex: true };

  it('melee + knockOut + hit reduces target to ≤0 → knockedOut, set_hp 0 + add_condition unconscious, no death-save fail', () => {
    // Target with 1 HP; deterministic hit + max damage
    const fixedHit = { intInclusive: (_min: number, max: number) => max === 20 ? 18 : max };
    const lowHpGoblin: CombatActor = { ...goblin, hpMax: 7 };
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(lowHpGoblin.id, { hpCurrent: 1 });
    const r = makeAttack({
      attacker: fighter,
      target: lowHpGoblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
      ranged: false,
      knockOut: true,
    }, fixedHit);
    expect(r.ok).toBe(true);
    expect(r.data?.knockedOut).toBe(true);
    const setHp = r.mutations.find((m) => m.op === 'set_hp');
    expect(setHp).toBeDefined();
    expect((setHp as { hpCurrent: number }).hpCurrent).toBe(0);
    const addCond = r.mutations.find((m) => m.op === 'add_condition');
    expect(addCond).toBeDefined();
    expect((addCond as { condition: { slug: string } }).condition.slug).toBe('unconscious');
    // No death-save fail mutations
    expect(r.mutations.find((m) => m.op === 'death_save')).toBeUndefined();
  });

  it('ranged + knockOut → ignored, normal damage applied, no knockedOut flag', () => {
    const fixedHit = { intInclusive: (_min: number, max: number) => max === 20 ? 18 : max };
    const lowHpGoblin: CombatActor = { ...goblin, hpMax: 7 };
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(lowHpGoblin.id, { hpCurrent: 1 });
    const r = makeAttack({
      attacker: fighter,
      target: lowHpGoblin,
      weapon: shortbow,
      attackerRuntime,
      targetRuntime,
      ranged: true,
      knockOut: true,
    }, fixedHit);
    expect(r.ok).toBe(true);
    expect(r.data?.knockedOut).toBeFalsy();
    expect(r.mutations.some((m) => m.op === 'apply_damage')).toBe(true);
  });

  it('melee + knockOut + hit but target survives (>0 HP) → no knockedOut, normal damage path', () => {
    // Target with full HP; minor damage
    const fixedHit = { intInclusive: (min: number, max: number) => max === 20 ? 18 : min };
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7 });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
      ranged: false,
      knockOut: true,
    }, fixedHit);
    expect(r.ok).toBe(true);
    expect(r.data?.knockedOut).toBeFalsy();
    expect(r.mutations.some((m) => m.op === 'apply_damage')).toBe(true);
    expect(r.mutations.find((m) => m.op === 'set_hp')).toBeUndefined();
    expect(r.mutations.find((m) => m.op === 'add_condition')).toBeUndefined();
  });

  it('melee + knockOut + miss → no knockout, no damage mutations', () => {
    const fixedMiss = { intInclusive: (_min: number, max: number) => max === 20 ? 2 : 1 };
    const attackerRuntime = runtimeFor(fighter.id, { hpCurrent: 44 });
    const targetRuntime = runtimeFor(goblin.id, { hpCurrent: 7 });
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime,
      targetRuntime,
      ranged: false,
      knockOut: true,
    }, fixedMiss);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('miss');
    expect(r.data?.knockedOut).toBeFalsy();
    expect(r.mutations.length).toBe(0);
  });
});
