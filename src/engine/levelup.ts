import type { ActionResult, Character, Mutation } from './types';
import { abilityModifier } from './modifiers';
import { rollDice } from './dice';
import { defaultRng, type Rng } from './rand';

export interface LevelUpInput {
  char: Character;
  newLevel: number;
  hpRollMode: 'average' | 'rolled';
}

export function levelUp(input: LevelUpInput, rng: Rng = defaultRng): ActionResult<{ levelsGained: number; hpDelta: number }> {
  if (input.newLevel <= input.char.level) {
    return { ok: false, error: 'not_an_increase', rolls: [], mutations: [] };
  }
  if (input.newLevel > 20) {
    return { ok: false, error: 'above_cap', rolls: [], mutations: [] };
  }

  const conMod = abilityModifier(input.char.abilities.CON);
  const die = input.char.hitDieSize;
  const levels = input.newLevel - input.char.level;
  let hpDelta = 0;
  const rolls = [];

  if (input.hpRollMode === 'average') {
    // 5e average = ceil(die/2) + 1 (e.g. d10 → 6)
    const avg = Math.ceil(die / 2) + 1;
    hpDelta = (avg + conMod) * levels;
  } else {
    for (let i = 0; i < levels; i++) {
      const r = rollDice(`1d${die}`, rng);
      rolls.push(r);
      hpDelta += r.total + conMod;
    }
  }

  const mutations: Mutation[] = [
    { op: 'level_up', characterId: input.char.id, newLevel: input.newLevel, hpDelta },
  ];
  return {
    ok: true,
    data: { levelsGained: levels, hpDelta },
    rolls,
    mutations,
  };
}
