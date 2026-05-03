import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine';
import type { EngineState, Character, Mutation } from '@/engine';

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const cloneRuntime = { ...state.runtime };
  switch (m.op) {
    case 'spend_hit_die': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hitDiceRemaining: (r.hitDiceRemaining ?? 0) - 1 };
      return { ...state, runtime: cloneRuntime };
    }
    case 'restore_hit_dice': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hitDiceRemaining: (r.hitDiceRemaining ?? 0) + m.amount };
      return { ...state, runtime: cloneRuntime };
    }
    case 'heal': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hpCurrent: r.hpCurrent + m.amount };
      return { ...state, runtime: cloneRuntime };
    }
    case 'set_hp': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hpCurrent: m.hpCurrent };
      return { ...state, runtime: cloneRuntime };
    }
    case 'set_temp_hp': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, tempHp: m.amount };
      return { ...state, runtime: cloneRuntime };
    }
    case 'use_resource': {
      const r = cloneRuntime[m.actorId]!;
      const used = r.resourcesUsed ?? {};
      cloneRuntime[m.actorId] = { ...r, resourcesUsed: { ...used, [m.featureSlug]: (used[m.featureSlug] ?? 0) + m.amount } };
      return { ...state, runtime: cloneRuntime };
    }
    case 'restore_resource': {
      const r = cloneRuntime[m.actorId]!;
      const used = r.resourcesUsed ?? {};
      cloneRuntime[m.actorId] = { ...r, resourcesUsed: { ...used, [m.featureSlug]: Math.max(0, (used[m.featureSlug] ?? 0) - m.amount) } };
      return { ...state, runtime: cloneRuntime };
    }
    default:
      return state;
  }
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null,
  features: [
    { slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second wind' },
    { slug: 'action_surge', source: 'class', usesMax: 1, description: 'Action surge' },
  ],
  inventory: [], hitDiceMax: 5, hitDieSize: 10,
};

describe('full rest cycle', () => {
  it('use second_wind, take short rest, second_wind restored', () => {
    let state: EngineState = {
      characters: [fighter],
      combatActors: [],
      runtime: {
        pc1: { actorId: 'pc1', hpCurrent: 30, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, resourcesUsed: {} },
      },
      combat: null,
      scene: '',
    };

    const useR = TOOL_HANDLERS['use_resource']!(state, { actor: 'player_character', featureSlug: 'second_wind' });
    expect(useR.ok).toBe(true);
    state = applyAll(state, useR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.second_wind).toBe(1);

    const restR = TOOL_HANDLERS['short_rest']!(state, { actor: 'player_character', hitDiceSpent: 2 });
    expect(restR.ok).toBe(true);
    state = applyAll(state, restR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.second_wind).toBe(0);    // restored
    expect(state.runtime.pc1!.hitDiceRemaining).toBe(3);              // 5 - 2 spent
    expect(state.runtime.pc1!.hpCurrent).toBeGreaterThan(30);
  });

  it('action_surge does NOT restore on short rest (long-rest only in Plan B)', () => {
    let state: EngineState = {
      characters: [fighter],
      combatActors: [],
      runtime: {
        pc1: { actorId: 'pc1', hpCurrent: 30, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, resourcesUsed: { action_surge: 1 } },
      },
      combat: null,
      scene: '',
    };

    const restR = TOOL_HANDLERS['short_rest']!(state, { actor: 'player_character', hitDiceSpent: 0 });
    expect(restR.ok).toBe(true);
    state = applyAll(state, restR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.action_surge).toBe(1);   // still used

    const longR = TOOL_HANDLERS['long_rest']!(state, { actor: 'player_character' });
    state = applyAll(state, longR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.action_surge).toBe(0);   // restored
    expect(state.runtime.pc1!.hpCurrent).toBe(44);
  });
});
