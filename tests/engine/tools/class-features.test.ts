import { describe, it, expect } from 'vitest';
import {
  handleEndRage,
  handleGrantBardicInspiration,
  handleStartRage,
  handleUseActionSurge,
  handleUseChannelDivinity,
  handleUseClassFeature,
  handleUseLayOnHands,
} from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  EngineState,
  FeatureInstance,
  TurnState,
} from '@/engine/types';

function feat(slug: string, usesMax: number | 'unlimited' = 1): FeatureInstance {
  return { slug, source: 'class', usesMax, description: slug };
}

function pc(opts: {
  id?: string;
  classSlug: string;
  level: number;
  classes?: { slug: string; level: number }[];
  features?: FeatureInstance[];
  abilities?: Partial<Character['abilities']>;
}): Character {
  return {
    id: opts.id ?? 'pc1',
    name: 'Test',
    level: opts.level,
    xp: 0,
    classSlug: opts.classSlug,
    classes: opts.classes,
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10, ...(opts.abilities ?? {}) },
    proficiencyBonus: 2 + Math.floor((opts.level - 1) / 4),
    hpMax: 30,
    ac: 14,
    speed: 30,
    proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null,
    features: opts.features ?? [],
    inventory: [],
    hitDiceMax: opts.level,
    hitDieSize: 10,
  };
}

function rt(opts: { actorId: string; conditions?: ActorRuntimeState['conditions']; resourcesUsed?: Record<string, number>; turnState?: Partial<TurnState>; hpCurrent?: number }): ActorRuntimeState {
  return {
    actorId: opts.actorId,
    hpCurrent: opts.hpCurrent ?? 30,
    tempHp: 0,
    conditions: opts.conditions ?? [],
    deathSaves: { successes: 0, failures: 0 },
    resourcesUsed: opts.resourcesUsed,
    turnState: opts.turnState
      ? { actionUsed: false, bonusUsed: false, reactionUsed: false, movementSpentFt: 0, freeInteractionsUsed: 0, dodging: false, disengaged: false, dashed: false, ...opts.turnState }
      : undefined,
  };
}

function makeState(opts: {
  characters: Character[];
  runtime: Record<string, ActorRuntimeState>;
  combatActors?: CombatActor[];
}): EngineState {
  return {
    characters: opts.characters,
    combatActors: opts.combatActors ?? [],
    runtime: opts.runtime,
    combat: null,
    scene: 'test',
  };
}

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('handleUseClassFeature (generic)', () => {
  it('rejects unknown actor', () => {
    const state = makeState({ characters: [], runtime: {} });
    const r = handleUseClassFeature(state, { actor: 'pc1', featureSlug: 'second_wind' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('rejects feature not on character', () => {
    const c = pc({ classSlug: 'fighter', level: 1, features: [] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleUseClassFeature(state, { actor: 'pc1', featureSlug: 'second_wind' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('feature_not_found');
  });

  it('rejects when no uses remaining', () => {
    const c = pc({ classSlug: 'fighter', level: 1, features: [feat('second_wind', 1)] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1', resourcesUsed: { second_wind: 1 } }) },
    });
    const r = handleUseClassFeature(state, { actor: 'pc1', featureSlug: 'second_wind' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_uses_remaining');
  });

  it('emits use_class_feature mutation on success', () => {
    const c = pc({ classSlug: 'fighter', level: 1, features: [feat('second_wind', 1)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleUseClassFeature(state, { actor: 'pc1', featureSlug: 'second_wind' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'use_class_feature', actorId: 'pc1', featureSlug: 'second_wind', uses: 1 },
    ]);
  });
});

describe('handleStartRage', () => {
  it('rejects non-barbarian', () => {
    const c = pc({ classSlug: 'fighter', level: 5, features: [feat('rage', 3)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleStartRage(state, { actor: 'pc1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_barbarian');
  });

  it('emits use_class_feature(rage) + add_condition(raging, 10 rounds)', () => {
    const c = pc({ classSlug: 'barbarian', level: 5, features: [feat('rage', 3)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleStartRage(state, { actor: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.data?.barbLevel).toBe(5);
    expect(r.data?.durationRounds).toBe(10);
    expect(r.mutations.length).toBe(2);
    expect(r.mutations[0]).toEqual({ op: 'use_class_feature', actorId: 'pc1', featureSlug: 'rage', uses: 1 });
    const addCond = r.mutations[1] as Extract<typeof r.mutations[number], { op: 'add_condition' }>;
    expect(addCond.op).toBe('add_condition');
    expect(addCond.condition.slug).toBe('raging');
    expect(addCond.condition.durationRounds).toBe(10);
  });

  it('rejects when out of uses', () => {
    const c = pc({ classSlug: 'barbarian', level: 5, features: [feat('rage', 3)] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1', resourcesUsed: { rage: 3 } }) },
    });
    const r = handleStartRage(state, { actor: 'pc1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_uses_remaining');
  });

  it('multi-class barbarian counts only barbarian levels', () => {
    const c = pc({
      classSlug: 'fighter',
      level: 6,
      classes: [
        { slug: 'fighter', level: 4 },
        { slug: 'barbarian', level: 2 },
      ],
      features: [feat('rage', 2)],
    });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleStartRage(state, { actor: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.data?.barbLevel).toBe(2);
  });
});

describe('handleEndRage', () => {
  it('idempotent when not raging', () => {
    const c = pc({ classSlug: 'barbarian', level: 5, features: [feat('rage', 3)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleEndRage(state, { actor: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.data?.wasRaging).toBe(false);
    expect(r.mutations).toEqual([]);
  });

  it('emits remove_condition(raging) when raging', () => {
    const c = pc({ classSlug: 'barbarian', level: 5, features: [feat('rage', 3)] });
    const state = makeState({
      characters: [c],
      runtime: {
        pc1: rt({
          actorId: 'pc1',
          conditions: [{ slug: 'raging', source: 'rage', durationRounds: 10, appliedRound: 0 }],
        }),
      },
    });
    const r = handleEndRage(state, { actor: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.data?.wasRaging).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'remove_condition', actorId: 'pc1', conditionSlug: 'raging' },
    ]);
  });
});

describe('handleUseActionSurge', () => {
  it('rejects non-fighter', () => {
    const c = pc({ classSlug: 'rogue', level: 5, features: [feat('action_surge', 1)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleUseActionSurge(state, { actor: 'pc1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_fighter');
  });

  it('emits use_class_feature + reset_action_for_surge', () => {
    const c = pc({ classSlug: 'fighter', level: 5, features: [feat('action_surge', 1)] });
    const state = makeState({
      characters: [c],
      runtime: {
        pc1: rt({ actorId: 'pc1', turnState: { actionUsed: true, bonusUsed: true } }),
      },
    });
    const r = handleUseActionSurge(state, { actor: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'use_class_feature', actorId: 'pc1', featureSlug: 'action_surge', uses: 1 },
      { op: 'reset_action_for_surge', actorId: 'pc1' },
    ]);
  });

  it('rejects when out of uses', () => {
    const c = pc({ classSlug: 'fighter', level: 5, features: [feat('action_surge', 1)] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1', resourcesUsed: { action_surge: 1 } }) },
    });
    const r = handleUseActionSurge(state, { actor: 'pc1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_uses_remaining');
  });
});

describe('handleUseChannelDivinity', () => {
  it('rejects non-cleric/paladin', () => {
    const c = pc({ classSlug: 'rogue', level: 5, features: [feat('channel_divinity', 1)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleUseChannelDivinity(state, { actor: 'pc1', effect: 'turn_undead' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_cleric_or_paladin');
  });

  it('cleric: emits use_class_feature(channel_divinity)', () => {
    const c = pc({ classSlug: 'cleric', level: 5, features: [feat('channel_divinity', 1)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleUseChannelDivinity(state, { actor: 'pc1', effect: 'turn_undead' });
    expect(r.ok).toBe(true);
    expect(r.data?.classSlug).toBe('cleric');
    expect(r.data?.effect).toBe('turn_undead');
    expect(r.mutations).toEqual([
      { op: 'use_class_feature', actorId: 'pc1', featureSlug: 'channel_divinity', uses: 1 },
    ]);
  });

  it('paladin: classSlug=paladin', () => {
    const c = pc({ classSlug: 'paladin', level: 5, features: [feat('channel_divinity', 1)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleUseChannelDivinity(state, { actor: 'pc1', effect: 'sacred_weapon' });
    expect(r.ok).toBe(true);
    expect(r.data?.classSlug).toBe('paladin');
  });
});

describe('handleGrantBardicInspiration', () => {
  it('rejects non-bard', () => {
    const c = pc({ classSlug: 'fighter', level: 5, features: [feat('bardic_inspiration', 3)] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleGrantBardicInspiration(state, { actor: 'pc1', targetId: 'm1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_bard');
  });

  it('rejects unknown target', () => {
    const c = pc({ classSlug: 'bard', level: 5, features: [feat('bardic_inspiration', 3)] });
    const state = makeState({ characters: [c], runtime: { pc1: rt({ actorId: 'pc1' }) } });
    const r = handleGrantBardicInspiration(state, { actor: 'pc1', targetId: 'unknown' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_target');
  });

  it('uses level-based die size at L5 → d8', () => {
    const c = pc({ classSlug: 'bard', level: 5, features: [feat('bardic_inspiration', 3)] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleGrantBardicInspiration(state, { actor: 'pc1', targetId: 'm1' });
    expect(r.ok).toBe(true);
    expect(r.data?.dieSize).toBe(8);
    const cond = r.mutations.find((m) => m.op === 'add_condition') as Extract<typeof r.mutations[number], { op: 'add_condition' }>;
    expect(cond.condition.slug).toBe('bardic_inspired');
    expect(cond.condition.source).toBe('bardic_inspiration:d8');
  });

  it('rejects invalid override die size', () => {
    const c = pc({ classSlug: 'bard', level: 5, features: [feat('bardic_inspiration', 3)] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleGrantBardicInspiration(state, { actor: 'pc1', targetId: 'm1', dieSize: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_die_size');
  });
});

describe('handleUseLayOnHands', () => {
  it('rejects non-paladin', () => {
    const c = pc({ classSlug: 'cleric', level: 5, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_paladin');
  });

  it('heals points + tracks pool spent', () => {
    const c = pc({ classSlug: 'paladin', level: 5, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 10 });
    expect(r.ok).toBe(true);
    expect(r.data?.poolBefore).toBe(25); // 5 * 5
    expect(r.data?.poolAfter).toBe(15);
    expect(r.mutations).toContainEqual({ op: 'heal', actorId: 'm1', amount: 10 });
    expect(r.mutations).toContainEqual({ op: 'modify_lay_on_hands_pool', actorId: 'pc1', delta: 10 });
  });

  it('cure poison costs 5 from pool + removes poisoned condition', () => {
    const c = pc({ classSlug: 'paladin', level: 5, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', curePoison: true });
    expect(r.ok).toBe(true);
    expect(r.data?.curedPoison).toBe(true);
    expect(r.mutations).toContainEqual({ op: 'remove_condition', actorId: 'm1', conditionSlug: 'poisoned' });
    expect(r.mutations).toContainEqual({ op: 'modify_lay_on_hands_pool', actorId: 'pc1', delta: 5 });
  });

  it('combines heal + cure_poison', () => {
    const c = pc({ classSlug: 'paladin', level: 5, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 8, curePoison: true });
    expect(r.ok).toBe(true);
    expect(r.data?.poolBefore).toBe(25);
    expect(r.data?.poolAfter).toBe(12); // 25 - (8 + 5)
  });

  it('rejects insufficient pool', () => {
    const c = pc({ classSlug: 'paladin', level: 1, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('insufficient_pool');
  });

  it('rejects nothing_to_do (zero points, no curePoison)', () => {
    const c = pc({ classSlug: 'paladin', level: 5, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1' }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('nothing_to_do');
  });

  it('respects already-spent pool', () => {
    const c = pc({ classSlug: 'paladin', level: 5, features: [feat('lay_on_hands', 'unlimited')] });
    const state = makeState({
      characters: [c],
      runtime: { pc1: rt({ actorId: 'pc1', resourcesUsed: { lay_on_hands: 20 } }) },
      combatActors: [goblin],
    });
    const r = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 10 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('insufficient_pool');
    // Edge: exactly 5 left.
    const r2 = handleUseLayOnHands(state, { actor: 'pc1', targetId: 'm1', points: 5 });
    expect(r2.ok).toBe(true);
    expect(r2.data?.poolAfter).toBe(0);
  });
});
