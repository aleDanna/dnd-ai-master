import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine';
import type { EngineState, Character, CombatActor, Mutation } from '@/engine';

function applyMutation(state: EngineState, m: Mutation): EngineState {
  // Minimal in-memory applicator for tests. Plan D will provide the real DB version.
  switch (m.op) {
    case 'set_hp':
      return { ...state, runtime: { ...state.runtime, [m.actorId]: { ...state.runtime[m.actorId]!, hpCurrent: m.hpCurrent } } };
    case 'apply_damage': {
      const r = state.runtime[m.actorId]!;
      return { ...state, runtime: { ...state.runtime, [m.actorId]: { ...r, hpCurrent: Math.max(0, r.hpCurrent - m.amount) } } };
    }
    case 'set_combat':
      return { ...state, combat: m.combat };
    case 'advance_turn':
      if (!state.combat) return state;
      const last = state.combat.currentIdx >= state.combat.turnOrder.length - 1;
      return {
        ...state,
        combat: {
          ...state.combat,
          currentIdx: last ? 0 : state.combat.currentIdx + 1,
          round: last ? state.combat.round + 1 : state.combat.round,
        },
      };
    default:
      return state;        // other ops not needed for this scenario
  }
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('full combat round', () => {
  it('roll initiative, attack until goblin dies, end turn', () => {
    let state: EngineState = {
      characters: [fighter],
      combatActors: [goblin],
      runtime: {
        pc1: { actorId: 'pc1', hpCurrent: 44, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
        m1:  { actorId: 'm1',  hpCurrent: 7,  tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
      },
      combat: null,
      scene: 'goblin warren',
    };

    const initR = TOOL_HANDLERS['roll_initiative']!(state, {});
    expect(initR.ok).toBe(true);
    state = applyAll(state, initR.mutations);
    expect(state.combat).not.toBeNull();

    let attempts = 0;
    while (state.runtime.m1!.hpCurrent > 0 && attempts < 30) {
      const atkR = TOOL_HANDLERS['make_attack']!(state, {
        attacker: 'player_character',
        target: 'm1',
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
      });
      state = applyAll(state, atkR.mutations);
      attempts++;
    }

    expect(state.runtime.m1!.hpCurrent).toBe(0);
    expect(attempts).toBeLessThan(30);

    const turnR = TOOL_HANDLERS['end_turn']!(state, {});
    expect(turnR.ok).toBe(true);
    state = applyAll(state, turnR.mutations);
    expect(state.combat?.currentIdx).toBeDefined();
  });
});
