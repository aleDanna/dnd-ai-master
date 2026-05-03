import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine/tools/handlers';

const awardXp = TOOL_HANDLERS.award_xp!;
import type { EngineState, Character } from '@/engine/types';

const character: Character = {
  id: 'pc1', name: 'Tharion', level: 3, xp: 900,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2, hpMax: 28, ac: 16, speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [],
    weapons: [], armor: [], tools: [], languages: [],
  },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 3, hitDieSize: 10,
};

const baseState: EngineState = {
  characters: [character],
  combatActors: [],
  runtime: {
    pc1: {
      actorId: 'pc1', hpCurrent: 28, tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [], hitDiceRemaining: 3,
      spellSlotsUsed: {}, resourcesUsed: {},
    },
  },
  combat: null,
  scene: '',
};

describe('award_xp tool', () => {
  it('returns an award_xp mutation with the requested amount', () => {
    const result = awardXp(baseState, { actor: 'pc1', amount: 250 });
    expect(result.ok).toBe(true);
    expect(result.mutations).toEqual([
      { op: 'award_xp', characterId: 'pc1', amount: 250, reason: undefined },
    ]);
  });

  it('passes a trimmed reason through to the mutation', () => {
    const result = awardXp(baseState, { actor: 'pc1', amount: 100, reason: '  defeated the goblin patrol  ' });
    expect(result.mutations[0]).toMatchObject({ reason: 'defeated the goblin patrol' });
  });

  it('reports newTotal in data so the master can narrate it', () => {
    const result = awardXp(baseState, { actor: 'pc1', amount: 250 });
    expect(result.data).toMatchObject({ awarded: 250, newTotal: 1150 });
  });

  it('floors fractional amounts and rejects zero', () => {
    expect(awardXp(baseState, { actor: 'pc1', amount: 0 }).ok).toBe(false);
    const r = awardXp(baseState, { actor: 'pc1', amount: 250.7 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({ amount: 250 });
  });

  it('resolves "player_character" sentinel to the only PC', () => {
    const result = awardXp(baseState, { actor: 'player_character', amount: 50 });
    expect(result.ok).toBe(true);
    expect(result.mutations[0]).toMatchObject({ characterId: 'pc1', amount: 50 });
  });

  it('errors gracefully on unknown actor', () => {
    const result = awardXp(baseState, { actor: 'nope', amount: 50 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown_actor');
  });
});
