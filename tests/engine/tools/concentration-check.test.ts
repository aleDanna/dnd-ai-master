import { describe, expect, it } from 'vitest';
import { handleConcentrationCheck } from '@/engine/tools/handlers';
import type { Ability, ActorRuntimeState, Character, EngineState, Mutation } from '@/engine/types';

// Helper: build a minimal EngineState containing a single PC ('pc1') that may
// or may not be concentrating. The test doubles narrow the surface needed by
// the handler: ability scores (CON), prof bonus, save proficiencies, and the
// runtime concentratingOn block.
function stateWithConcentratingPC(opts: {
  conScore?: number;
  profCon?: boolean;
  profBonus?: number;
  concentratingOn?: { spellSlug: string; slotLevel: 0|1|2|3|4|5|6|7|8|9; startedRound: number } | null;
} = {}): EngineState {
  const conScore = opts.conScore ?? 12; // +1 mod default
  const profBonus = opts.profBonus ?? 2;
  const profCon = opts.profCon ?? false;
  const concInput = opts.concentratingOn === undefined
    ? { spellSlug: 'bless', slotLevel: 1 as const, startedRound: 0 }
    : opts.concentratingOn;

  const pc: Character = {
    id: 'pc1',
    name: 'Cleric',
    level: 3,
    xp: 0,
    classSlug: 'cleric',
    raceSlug: 'human',
    backgroundSlug: 'acolyte',
    abilities: { STR: 10, DEX: 10, CON: conScore, INT: 10, WIS: 14, CHA: 10 },
    proficiencyBonus: profBonus,
    hpMax: 24,
    ac: 16,
    speed: 30,
    proficiencies: {
      saves: profCon ? (['CON'] as Ability[]) : ([] as Ability[]),
      skills: [],
      expertise: [],
      weapons: [],
      armor: [],
      tools: [],
      languages: [],
    },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 3,
    hitDieSize: 8,
  };

  const runtime: ActorRuntimeState = {
    actorId: 'pc1',
    hpCurrent: 20,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    concentratingOn: concInput ?? undefined,
  };

  return {
    characters: [pc],
    combatActors: [],
    runtime: { pc1: runtime },
    combat: null,
    scene: '',
  };
}

describe('tool concentration_check', () => {
  it('CON save >= DC -> success, no break_concentration mutation', () => {
    // CON 14 -> +2 mod, no proficiency. rng=0.95 -> d20=Math.floor(0.95*20)+1 = 20.
    // total = 20 + 2 = 22 >= 10 -> success.
    const state = stateWithConcentratingPC({ conScore: 14, profCon: false });
    const result = handleConcentrationCheck({ rng: () => 0.95 }, state, {
      actorId: 'pc1',
      dc: 10,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { success: boolean }).success).toBe(true);
    const breakMut = result.mutations.find(
      (m): m is Extract<Mutation, { op: 'break_concentration' }> =>
        m.op === 'break_concentration',
    );
    expect(breakMut).toBeUndefined();
  });

  it('CON save < DC -> failure, emits break_concentration with reason=damage', () => {
    // CON 10 -> +0 mod, no proficiency. rng=0.05 -> d20=2.
    // total = 2 + 0 = 2 < 15 -> fail.
    const state = stateWithConcentratingPC({ conScore: 10, profCon: false });
    const result = handleConcentrationCheck({ rng: () => 0.05 }, state, {
      actorId: 'pc1',
      dc: 15,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { success: boolean }).success).toBe(false);
    const breakMut = result.mutations.find(
      (m): m is Extract<Mutation, { op: 'break_concentration' }> =>
        m.op === 'break_concentration',
    );
    expect(breakMut).toBeDefined();
    expect(breakMut?.reason).toBe('damage');
    expect(breakMut?.actorId).toBe('pc1');
  });

  it('proficiency in CON saves applies the prof bonus', () => {
    // CON 14 -> +2 mod, proficient with prof bonus 3. rng=0.5 -> d20=11.
    // total = 11 + 2 + 3 = 16 >= 15 -> success.
    const state = stateWithConcentratingPC({ conScore: 14, profCon: true, profBonus: 3 });
    const result = handleConcentrationCheck({ rng: () => 0.5 }, state, {
      actorId: 'pc1',
      dc: 15,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { total: number }).total).toBe(16);
    expect((result.data as { success: boolean }).success).toBe(true);
  });

  it('errors if actor not concentrating', () => {
    const state = stateWithConcentratingPC({ concentratingOn: null });
    const result = handleConcentrationCheck({ rng: () => 0.5 }, state, {
      actorId: 'pc1',
      dc: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not concentrating/i);
  });

  it('errors if actor not found', () => {
    const state = stateWithConcentratingPC({});
    const result = handleConcentrationCheck({ rng: () => 0.5 }, state, {
      actorId: 'unknown',
      dc: 10,
    });
    expect(result.ok).toBe(false);
  });
});
