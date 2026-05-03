import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine/tools/handlers';
import type { EngineState, Character, CombatState } from '@/engine/types';

const endCombat = TOOL_HANDLERS.end_combat!;

const character: Character = {
  id: 'pc1', name: 'Tharion', level: 3, xp: 900,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2, hpMax: 28, ac: 16, speed: 30,
  proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 3, hitDieSize: 10,
};

function stateWith(combat: CombatState | null): EngineState {
  return {
    characters: [character],
    combatActors: [],
    runtime: {
      pc1: { actorId: 'pc1', hpCurrent: 28, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 3, spellSlotsUsed: {}, resourcesUsed: {} },
    },
    combat,
    scene: '',
  };
}

describe('end_combat tool', () => {
  it('emits a set_combat null mutation when combat is active', () => {
    const combat: CombatState = {
      round: 3,
      currentIdx: 1,
      turnOrder: [{ actorId: 'pc1', initiative: 18 }, { actorId: 'goblin', initiative: 12 }],
    };
    const result = endCombat(stateWith(combat), {});
    expect(result.ok).toBe(true);
    expect(result.mutations).toEqual([{ op: 'set_combat', combat: null }]);
    expect(result.data).toMatchObject({ roundsElapsed: 3 });
  });

  it('errors gracefully when not currently in combat', () => {
    const result = endCombat(stateWith(null), {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_in_combat');
    expect(result.mutations).toEqual([]);
  });
});
