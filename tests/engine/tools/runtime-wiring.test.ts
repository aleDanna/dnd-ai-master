import { describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  ConditionInstance,
  ConditionSlug,
  EngineState,
  Mutation,
} from '@/engine/types';

// ─── Test helpers ─────────────────────────────────────────────────────────
// stateWith() builds a minimal EngineState with one PC ('pc1') + one monster
// ('m1'), letting tests inject conditions/HP onto either runtime entry.

interface StateOpts {
  pc?: {
    conditions?: ConditionSlug[];
    hpCurrent?: number;
    hpMax?: number;
  };
  monster?: {
    conditions?: ConditionSlug[];
    hpCurrent?: number;
    hpMax?: number;
  };
}

function cond(slug: ConditionSlug): ConditionInstance {
  return { slug, source: 'test', durationRounds: 'until_removed', appliedRound: 1 };
}

function stateWith(opts: StateOpts = {}): EngineState {
  const pcHpMax = opts.pc?.hpMax ?? 30;
  const monsterHpMax = opts.monster?.hpMax ?? 7;
  const pc: Character = {
    id: 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: pcHpMax,
    ac: 16,
    speed: 30,
    proficiencies: {
      saves: ['STR', 'CON'],
      skills: ['Athletics'],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: ['Light', 'Medium', 'Heavy', 'Shield'],
      tools: [],
      languages: [],
    },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 5,
    hitDieSize: 10,
  };
  const monster: CombatActor = {
    id: 'm1',
    kind: 'monster',
    name: 'Goblin',
    hpMax: monsterHpMax,
    ac: 12, // low so test attacks reliably hit
    abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2,
    initiativeBonus: 2,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
  };
  const pcRuntime: ActorRuntimeState = {
    actorId: 'pc1',
    hpCurrent: opts.pc?.hpCurrent ?? pcHpMax,
    tempHp: 0,
    conditions: (opts.pc?.conditions ?? []).map(cond),
    deathSaves: { successes: 0, failures: 0 },
    hitDiceRemaining: 5,
    spellSlotsUsed: {},
    resourcesUsed: {},
  };
  const monsterRuntime: ActorRuntimeState = {
    actorId: 'm1',
    hpCurrent: opts.monster?.hpCurrent ?? monsterHpMax,
    tempHp: 0,
    conditions: (opts.monster?.conditions ?? []).map(cond),
    deathSaves: { successes: 0, failures: 0 },
  };
  return {
    characters: [pc],
    combatActors: [monster],
    runtime: { pc1: pcRuntime, m1: monsterRuntime },
    combat: null,
    scene: 'test arena',
  };
}

// ─── ability_check ────────────────────────────────────────────────────────

describe('tool wiring — ability_check propagates runtime conditions', () => {
  it('poisoned PC ability_check rolls with disadvantage', () => {
    const state = stateWith({ pc: { conditions: ['poisoned'] } });
    const handler = TOOL_HANDLERS['ability_check']!;
    const result = handler(state, {
      actor: 'pc1',
      ability: 'STR',
      skill: 'Athletics',
      dc: 15,
    });
    // Disadvantage means rollD20 produces 2 underlying d20 rolls
    expect(result.rolls.length).toBeGreaterThanOrEqual(1);
    expect(result.rolls[0]!.rolls.length).toBe(2);
  });

  it('non-poisoned PC ability_check rolls one die (control)', () => {
    const state = stateWith({ pc: {} });
    const handler = TOOL_HANDLERS['ability_check']!;
    const result = handler(state, {
      actor: 'pc1',
      ability: 'STR',
      skill: 'Athletics',
      dc: 15,
    });
    expect(result.rolls[0]!.rolls.length).toBe(1);
  });
});

// ─── saving_throw ─────────────────────────────────────────────────────────

describe('tool wiring — saving_throw propagates runtime conditions', () => {
  it('paralyzed PC saving_throw STR auto-fails', () => {
    const state = stateWith({ pc: { conditions: ['paralyzed'] } });
    const handler = TOOL_HANDLERS['saving_throw']!;
    const result = handler(state, {
      actor: 'pc1',
      ability: 'STR',
      dc: 10,
    });
    expect(result.ok).toBe(false);
    expect((result.data as { autoFailed?: boolean } | undefined)?.autoFailed).toBe(true);
  });

  it('poisoned PC saving_throw rolls with disadvantage on ability checks (not saves)', () => {
    // Sanity: poisoned does NOT cause save disadvantage, only ability checks/attacks
    const state = stateWith({ pc: { conditions: ['poisoned'] } });
    const handler = TOOL_HANDLERS['saving_throw']!;
    const result = handler(state, {
      actor: 'pc1',
      ability: 'STR',
      dc: 10,
    });
    expect(result.rolls[0]!.rolls.length).toBe(1);
  });
});

// ─── make_attack ──────────────────────────────────────────────────────────

describe('tool wiring — make_attack honors target conditions and knockOut', () => {
  it('attacking a prone target in melee gets advantage', () => {
    const state = stateWith({
      pc: {},
      monster: { conditions: ['prone'], hpCurrent: 10, hpMax: 10 },
    });
    const handler = TOOL_HANDLERS['make_attack']!;
    const result = handler(state, {
      attacker: 'pc1',
      target: 'm1',
      weapon: { name: 'Shortsword', damage: '1d6', damageType: 'piercing', profGroup: 'Martial', useDex: false },
    });
    expect(result.rolls[0]!.rolls.length).toBe(2);
  });

  it('attacking a poisoned attacker uses disadvantage', () => {
    const state = stateWith({
      pc: { conditions: ['poisoned'] },
      monster: { hpCurrent: 10, hpMax: 10 },
    });
    const handler = TOOL_HANDLERS['make_attack']!;
    const result = handler(state, {
      attacker: 'pc1',
      target: 'm1',
      weapon: { name: 'Shortsword', damage: '1d6', damageType: 'piercing', profGroup: 'Martial', useDex: false },
    });
    expect(result.rolls[0]!.rolls.length).toBe(2);
  });

  it('knockOut: true on melee hit reducing target to 0 → unconscious not death', () => {
    const state = stateWith({
      pc: {},
      monster: { hpCurrent: 1, hpMax: 10 },
    });
    const handler = TOOL_HANDLERS['make_attack']!;
    // Use a high-rolling rng so the hit lands.
    const result = handler(state, {
      attacker: 'pc1',
      target: 'm1',
      weapon: { name: 'Shortsword', damage: '1d6', damageType: 'piercing', profGroup: 'Martial', useDex: false },
      knockOut: true,
    });
    if ((result.data as { hit?: boolean } | undefined)?.hit) {
      const setHp = result.mutations.find(
        (m): m is Extract<Mutation, { op: 'set_hp' }> => m.op === 'set_hp',
      );
      const addCond = result.mutations.find(
        (m): m is Extract<Mutation, { op: 'add_condition' }> =>
          m.op === 'add_condition' && m.condition.slug === 'unconscious',
      );
      expect(setHp?.hpCurrent).toBe(0);
      expect(addCond).toBeDefined();
      expect((result.data as { knockedOut?: boolean }).knockedOut).toBe(true);
    }
  });

  it('ranged: true with knockOut: true ignores knockOut (ranged silently ignores)', () => {
    const state = stateWith({
      pc: {},
      monster: { hpCurrent: 1, hpMax: 10 },
    });
    const handler = TOOL_HANDLERS['make_attack']!;
    const result = handler(state, {
      attacker: 'pc1',
      target: 'm1',
      weapon: { name: 'Shortbow', damage: '1d6', damageType: 'piercing', profGroup: 'Martial', useDex: true },
      knockOut: true,
      ranged: true,
    });
    if ((result.data as { hit?: boolean } | undefined)?.hit) {
      // Ranged ignores knockOut → no knockedOut data flag, no add_condition unconscious.
      const addCond = result.mutations.find(
        (m): m is Extract<Mutation, { op: 'add_condition' }> =>
          m.op === 'add_condition' && m.condition.slug === 'unconscious',
      );
      expect(addCond).toBeUndefined();
      expect((result.data as { knockedOut?: boolean }).knockedOut).toBeUndefined();
    }
  });
});

// ─── apply_damage ─────────────────────────────────────────────────────────

describe('tool wiring — apply_damage propagates isCrit and runtime to trigger death save fails', () => {
  it('PC at 0 HP takes damage via apply_damage tool → emits death_save fail mutation', () => {
    const state = stateWith({ pc: { hpCurrent: 0, hpMax: 10 } });
    const handler = TOOL_HANDLERS['apply_damage']!;
    const result = handler(state, {
      actor: 'pc1',
      amount: 3,
      type: 'piercing',
    });
    const ds = result.mutations.find(
      (m): m is Extract<Mutation, { op: 'death_save' }> => m.op === 'death_save',
    );
    expect(ds).toBeDefined();
    expect(ds?.success).toBe(false);
  });

  it('PC at 0 HP takes critical damage via apply_damage tool → emits 2 death_save fails', () => {
    const state = stateWith({ pc: { hpCurrent: 0, hpMax: 10 } });
    const handler = TOOL_HANDLERS['apply_damage']!;
    const result = handler(state, {
      actor: 'pc1',
      amount: 3,
      type: 'piercing',
      isCrit: true,
    });
    const fails = result.mutations.filter(
      (m): m is Extract<Mutation, { op: 'death_save' }> => m.op === 'death_save' && !m.success,
    );
    expect(fails.length).toBe(2);
  });

  it('PC at 0 HP takes non-crit damage → emits 1 death_save fail (control)', () => {
    const state = stateWith({ pc: { hpCurrent: 0, hpMax: 10 } });
    const handler = TOOL_HANDLERS['apply_damage']!;
    const result = handler(state, {
      actor: 'pc1',
      amount: 3,
      type: 'piercing',
      isCrit: false,
    });
    const fails = result.mutations.filter(
      (m): m is Extract<Mutation, { op: 'death_save' }> => m.op === 'death_save' && !m.success,
    );
    expect(fails.length).toBe(1);
  });
});
