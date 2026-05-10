import { describe, it, expect } from 'vitest';
import { applyDamage } from '@/engine/combat/damage';
import type { ActorRuntimeState, CombatActor, Character, DamageType } from '@/engine/types';

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: ['fire'], conditionImmunities: [],
};

const goblinRuntime: ActorRuntimeState = {
  actorId: 'm1', hpCurrent: 7, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 },
};

describe('applyDamage', () => {
  it('reduces hpCurrent by amount', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 4, type: 'slashing' });
    expect(r.data?.newHp).toBe(3);
    expect(r.mutations[0]).toEqual({ op: 'set_hp', actorId: 'm1', hpCurrent: 3 });
  });

  it('applies vulnerability (doubles)', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 3, type: 'fire' });
    expect(r.data?.newHp).toBe(7 - 6);
  });

  it('temp HP absorbs damage first', () => {
    const withTemp: ActorRuntimeState = { ...goblinRuntime, tempHp: 3 };
    const r = applyDamage({ runtime: withTemp, target: goblin, amount: 5, type: 'slashing' });
    expect(r.data?.newTempHp).toBe(0);
    expect(r.data?.newHp).toBe(7 - 2);                            // 5 - 3 temp = 2 to hp
    expect(r.mutations.some((m) => m.op === 'set_temp_hp')).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp')).toBe(true);
  });

  it('clamps hp at 0 (no negative HP for monsters)', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 100, type: 'fire' });
    expect(r.data?.newHp).toBe(0);
  });

  it('PCs at 0 HP enter death save state, not dead', () => {
    const fighter: Character = {
      id: 'pc1', name: 'Tharion', level: 1, xp: 0,
      classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    };
    const fighterRuntime: ActorRuntimeState = { actorId: 'pc1', hpCurrent: 4, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } };
    const r = applyDamage({ runtime: fighterRuntime, target: fighter as unknown as CombatActor, amount: 10, type: 'slashing' });
    expect(r.data?.newHp).toBe(0);
    expect(r.data?.dying).toBe(true);
  });

  it('massive damage: PC drops to 0 with leftover ≥ hpMax → instant death', () => {
    const fighter: Character = {
      id: 'pc1', name: 'Tharion', level: 1, xp: 0,
      classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    };
    const fighterRuntime: ActorRuntimeState = { actorId: 'pc1', hpCurrent: 5, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } };
    const r = applyDamage({ runtime: fighterRuntime, target: fighter as unknown as CombatActor, amount: 30, type: 'slashing' });
    expect(r.data?.dead).toBe(true);
  });
});

// ─── Helpers for death-save tests (PHB §3.17–3.18) ─────────────────────────

function pcAt0Hp(opts: { hpMax?: number } = {}): Character {
  return {
    id: 'pc1', name: 'Tharion', level: 1, xp: 0,
    classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
    proficiencyBonus: 2, hpMax: opts.hpMax ?? 10, ac: 16, speed: 30,
    proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
  };
}

function runtimeAt0Hp(opts: Partial<ActorRuntimeState> = {}): ActorRuntimeState {
  return {
    actorId: 'pc1',
    hpCurrent: 0,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    ...opts,
  };
}

describe('applyDamage — death save fail at 0 HP', () => {
  it('PC at 0 HP takes damage → +1 death save failure', () => {
    const target = pcAt0Hp({ hpMax: 10 });
    const runtime = runtimeAt0Hp({ deathSaves: { successes: 1, failures: 0 } });
    const result = applyDamage({
      runtime,
      target: target as unknown as CombatActor,
      amount: 5,
      type: 'piercing',
      isCrit: false,
    });
    const ds = result.mutations.find((m) => m.op === 'death_save');
    expect(ds).toBeDefined();
    if (ds && ds.op === 'death_save') {
      expect(ds.success).toBe(false);
    }
    // exactly one failure mutation (not two)
    expect(result.mutations.filter((m) => m.op === 'death_save').length).toBe(1);
  });

  it('PC at 0 HP takes critical damage → +2 death save failures', () => {
    const target = pcAt0Hp({ hpMax: 10 });
    const runtime = runtimeAt0Hp();
    const result = applyDamage({
      runtime,
      target: target as unknown as CombatActor,
      amount: 8,
      type: 'piercing',
      isCrit: true,
    });
    const dsFails = result.mutations.filter(
      (m) => m.op === 'death_save' && m.success === false,
    );
    expect(dsFails.length).toBe(2);
  });

  it('PC at 0 HP takes damage ≥ hpMax → instant death (no death save mutations)', () => {
    const target = pcAt0Hp({ hpMax: 10 });
    const runtime = runtimeAt0Hp();
    const result = applyDamage({
      runtime,
      target: target as unknown as CombatActor,
      amount: 10,
      type: 'piercing',
      isCrit: false,
    });
    expect(result.data?.dead).toBe(true);
    const ds = result.mutations.find((m) => m.op === 'death_save');
    expect(ds).toBeUndefined();
    // should still emit set_hp 0 and unconscious condition
    const setHp = result.mutations.find((m) => m.op === 'set_hp');
    expect(setHp).toBeDefined();
    const addCond = result.mutations.find(
      (m) => m.op === 'add_condition' && m.condition.slug === 'unconscious',
    );
    expect(addCond).toBeDefined();
  });

  it('PC with current HP > 0 takes damage normally (no death_save mutations)', () => {
    const target = pcAt0Hp({ hpMax: 10 });
    const runtime: ActorRuntimeState = { ...runtimeAt0Hp(), hpCurrent: 5 };
    const result = applyDamage({
      runtime,
      target: target as unknown as CombatActor,
      amount: 3,
      type: 'piercing',
    });
    const ds = result.mutations.find((m) => m.op === 'death_save');
    expect(ds).toBeUndefined();
  });
});

// ─── Helpers for concentration-check tests (PHB §8.8) ──────────────────────

function pcAlive(opts: { hpMax?: number; immunities?: DamageType[] } = {}): Character {
  return {
    id: 'pc1', name: 'Tharion', level: 1, xp: 0,
    classSlug: 'wizard', raceSlug: 'human', backgroundSlug: 'sage',
    abilities: { STR: 10, DEX: 12, CON: 14, INT: 16, WIS: 12, CHA: 8 },
    proficiencyBonus: 2, hpMax: opts.hpMax ?? 30, ac: 12, speed: 30,
    proficiencies: { saves: ['INT', 'WIS'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 6,
    // PC immunities/resistances aren't on the Character type; we attach them
    // via the runtime/target shape instead. The `modifyForResistance` helper
    // currently treats PCs as fully vulnerable, so for the immunity test we
    // pass a CombatActor-shaped object via the helper below.
    ...(opts.immunities ? { __immunities: opts.immunities } : {}),
  } as Character & { __immunities?: DamageType[] };
}

function runtimeFor(target: Character, opts: Partial<ActorRuntimeState> = {}): ActorRuntimeState {
  return {
    actorId: target.id,
    hpCurrent: target.hpMax,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    ...opts,
  };
}

/**
 * Build a CombatActor shape from a PC + immunities so resistance handling
 * (which currently exempts Character-shaped targets) can be exercised.
 * Plan B doesn't model PC resistances on the Character type, so the test
 * threads them through a non-PC target wrapper.
 */
function pcAsCombatActorWithImmunities(target: Character, immunities: DamageType[]): CombatActor {
  return {
    id: target.id, kind: 'pc', name: target.name,
    hpMax: target.hpMax, ac: target.ac,
    abilities: target.abilities,
    proficiencyBonus: target.proficiencyBonus, initiativeBonus: 0,
    resistances: [], immunities, vulnerabilities: [], conditionImmunities: [],
  };
}

describe('applyDamage — concentration check', () => {
  it('target concentrating takes damage 21 → emits concentration_check with DC 10', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 30,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target: target as unknown as CombatActor,
      runtime,
      amount: 21,
      type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeDefined();
    if (conMut?.op === 'concentration_check') {
      expect(conMut.dc).toBe(10);
      expect(conMut.spellSlug).toBe('bless');
    }
  });

  it('damage 22 → DC 11', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 30,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target: target as unknown as CombatActor,
      runtime,
      amount: 22,
      type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeDefined();
    if (conMut?.op === 'concentration_check') {
      expect(conMut.dc).toBe(11);
    }
  });

  it('damage 100 → DC 50', () => {
    const target = pcAlive({ hpMax: 200 });
    const runtime = runtimeFor(target, {
      hpCurrent: 200,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target: target as unknown as CombatActor,
      runtime,
      amount: 100,
      type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeDefined();
    if (conMut?.op === 'concentration_check') {
      expect(conMut.dc).toBe(50);
    }
  });

  it('target NOT concentrating → no concentration_check', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, { hpCurrent: 30 });
    const result = applyDamage({
      target: target as unknown as CombatActor,
      runtime,
      amount: 22,
      type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeUndefined();
  });

  it('target concentrating takes 0 damage (immunity) → no concentration_check', () => {
    const target = pcAlive({ hpMax: 30 });
    const actor = pcAsCombatActorWithImmunities(target, ['fire']);
    const runtime = runtimeFor(target, {
      hpCurrent: 30,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target: actor,
      runtime,
      amount: 100,
      type: 'fire',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeUndefined();
  });

  it('target concentrating drops to 0 HP → break_concentration with reason=incapacitated, no concentration_check', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 5,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target: target as unknown as CombatActor,
      runtime,
      amount: 20,
      type: 'piercing',
    });
    const breakMut = result.mutations.find((m) => m.op === 'break_concentration');
    expect(breakMut).toBeDefined();
    if (breakMut?.op === 'break_concentration') {
      expect(breakMut.reason).toBe('incapacitated');
    }
    const conCheck = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conCheck).toBeUndefined();
  });

  it('target concentrating dies from massive damage → break_concentration with reason=killed', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 5,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target: target as unknown as CombatActor,
      runtime,
      amount: 50,
      type: 'piercing',
    });
    const breakMut = result.mutations.find((m) => m.op === 'break_concentration');
    expect(breakMut).toBeDefined();
    if (breakMut?.op === 'break_concentration') {
      expect(breakMut.reason).toBe('killed');
    }
  });
});
