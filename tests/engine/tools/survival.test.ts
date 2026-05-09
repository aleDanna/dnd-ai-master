import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleApplyDehydration,
  handleApplyStarvation,
  handleForcedMarch,
} from '@/engine/tools/handlers';
import { TOOL_DEFINITIONS } from '@/engine/tools';
import type { Character, EngineState } from '@/engine/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const baseFighter: Character = {
  id: 'pc1',
  name: 'Tharion',
  level: 3,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 14, DEX: 12, CON: 10, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 24,
  ac: 16,
  speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'],
    skills: ['Athletics'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    tools: [],
    languages: ['Common'],
  },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 3,
  hitDieSize: 10,
};

function stateWith(char: Character): EngineState {
  return {
    characters: [char],
    combatActors: [],
    runtime: {
      [char.id]: {
        actorId: char.id,
        hpCurrent: char.hpMax,
        tempHp: 0,
        deathSaves: { successes: 0, failures: 0 },
        conditions: [],
      },
    },
    combat: null,
    scene: 'overland trek',
  };
}

// rng helper: produce a value that, after Math.floor(rng() * 20) + 1, yields N.
function rngFor(n: number): () => number {
  return () => (n - 0.5) / 20;
}

// ─── handleForcedMarch ─────────────────────────────────────────────────────

describe('handleForcedMarch (PHB §6.3)', () => {
  it('≤8 hours: no save, no mutation, dc:0, saveSuccess:true', () => {
    const state = stateWith(baseFighter);
    const r = handleForcedMarch({ rng: rngFor(1) }, state, {
      actor: baseFighter.id,
      hoursTraveled: 8,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.dc).toBe(0);
    expect(r.data?.saveSuccess).toBe(true);
    expect(r.data?.exhaustionApplied).toBe(false);
    expect(r.mutations).toEqual([]);
    expect(r.rolls).toEqual([]);
  });

  it('9 hours, CON 10 (mod 0), no prof: rolls save vs DC 11, fail on roll 5 → exhaustion mutation', () => {
    const fighter = { ...baseFighter, proficiencies: { ...baseFighter.proficiencies, saves: ['STR'] as const } } as Character;
    const state = stateWith(fighter);
    const r = handleForcedMarch({ rng: rngFor(5) }, state, {
      actor: fighter.id,
      hoursTraveled: 9,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.dc).toBe(11);
    expect(r.data?.saveRoll).toBe(5);
    expect(r.data?.saveTotal).toBe(5);
    expect(r.data?.saveSuccess).toBe(false);
    expect(r.data?.exhaustionApplied).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'add_condition',
        actorId: fighter.id,
        condition: {
          slug: 'exhaustion',
          source: 'forced march',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);
  });

  it('9 hours, success on roll 15 → no mutation', () => {
    const fighter = { ...baseFighter, proficiencies: { ...baseFighter.proficiencies, saves: ['STR'] as const } } as Character;
    const state = stateWith(fighter);
    const r = handleForcedMarch({ rng: rngFor(15) }, state, {
      actor: fighter.id,
      hoursTraveled: 9,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.saveSuccess).toBe(true);
    expect(r.data?.exhaustionApplied).toBe(false);
    expect(r.mutations).toEqual([]);
    expect(r.rolls).toHaveLength(1);
    expect(r.rolls[0]?.formula).toBe('1d20+CON');
  });

  it('CON proficiency adds proficiency bonus to the save total', () => {
    // Fighter has CON saves proficient; PB=2; CON 10 → mod 0; total should be roll+2.
    const state = stateWith(baseFighter);
    const r = handleForcedMarch({ rng: rngFor(10) }, state, {
      actor: baseFighter.id,
      hoursTraveled: 10, // DC 12
    });
    expect(r.ok).toBe(true);
    expect(r.data?.saveRoll).toBe(10);
    expect(r.data?.saveTotal).toBe(12); // 10 + 0 (mod) + 2 (prof)
    expect(r.data?.saveSuccess).toBe(true);
    expect(r.data?.exhaustionApplied).toBe(false);
  });

  it('unknown actor → unknown_character error', () => {
    const state = stateWith(baseFighter);
    const r = handleForcedMarch({ rng: rngFor(10) }, state, {
      actor: 'ghost',
      hoursTraveled: 12,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
    expect(r.mutations).toEqual([]);
  });
});

// ─── handleApplyStarvation ─────────────────────────────────────────────────

describe('handleApplyStarvation (PHB §6.7)', () => {
  it('CON 10 (mod 0): 3-day survival window — 1, 2, 3 days = no exhaustion', () => {
    const state = stateWith(baseFighter);
    for (const days of [1, 2, 3]) {
      const r = handleApplyStarvation(state, {
        actor: baseFighter.id,
        daysWithoutFood: days,
      });
      expect(r.ok).toBe(true);
      expect(r.data?.exhaustionApplied).toBe(false);
      expect(r.data?.survivalDays).toBe(3);
      expect(r.mutations).toEqual([]);
    }
  });

  it('CON 10: 4 days = exhaustion mutation', () => {
    const state = stateWith(baseFighter);
    const r = handleApplyStarvation(state, {
      actor: baseFighter.id,
      daysWithoutFood: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.exhaustionApplied).toBe(true);
    expect(r.data?.survivalDays).toBe(3);
    expect(r.mutations).toEqual([
      {
        op: 'add_condition',
        actorId: baseFighter.id,
        condition: {
          slug: 'exhaustion',
          source: 'starvation',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);
  });

  it('CON 16 (mod +3): 6-day survival window — 6 days = no exhaustion, 7 days = exhaustion', () => {
    const tough = { ...baseFighter, abilities: { ...baseFighter.abilities, CON: 16 } };
    const state = stateWith(tough);

    const r6 = handleApplyStarvation(state, { actor: tough.id, daysWithoutFood: 6 });
    expect(r6.data?.survivalDays).toBe(6);
    expect(r6.data?.exhaustionApplied).toBe(false);
    expect(r6.mutations).toEqual([]);

    const r7 = handleApplyStarvation(state, { actor: tough.id, daysWithoutFood: 7 });
    expect(r7.data?.survivalDays).toBe(6);
    expect(r7.data?.exhaustionApplied).toBe(true);
    expect(r7.mutations).toHaveLength(1);
  });

  it('CON 4 (mod -3): minimum 1-day window — 1 day = no exhaustion, 2 days = exhaustion', () => {
    const frail = { ...baseFighter, abilities: { ...baseFighter.abilities, CON: 4 } };
    const state = stateWith(frail);

    const r1 = handleApplyStarvation(state, { actor: frail.id, daysWithoutFood: 1 });
    expect(r1.data?.survivalDays).toBe(1);
    expect(r1.data?.exhaustionApplied).toBe(false);

    const r2 = handleApplyStarvation(state, { actor: frail.id, daysWithoutFood: 2 });
    expect(r2.data?.survivalDays).toBe(1);
    expect(r2.data?.exhaustionApplied).toBe(true);
  });

  it('unknown actor → unknown_character error', () => {
    const state = stateWith(baseFighter);
    const r = handleApplyStarvation(state, { actor: 'ghost', daysWithoutFood: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

// ─── handleApplyDehydration ────────────────────────────────────────────────

describe('handleApplyDehydration (PHB §6.7)', () => {
  it('daysWithLessThanHalfWater < 1: no-op', () => {
    const state = stateWith(baseFighter);
    const r = handleApplyDehydration({ rng: rngFor(1) }, state, {
      actor: baseFighter.id,
      daysWithLessThanHalfWater: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.exhaustionApplied).toBe(false);
    expect(r.data?.dc).toBe(0);
    expect(r.mutations).toEqual([]);
    expect(r.rolls).toEqual([]);
  });

  it('1 day: rolls vs DC 15; fail on roll 5 → exhaustion', () => {
    const fighter = { ...baseFighter, proficiencies: { ...baseFighter.proficiencies, saves: ['STR'] as const } } as Character;
    const state = stateWith(fighter);
    const r = handleApplyDehydration({ rng: rngFor(5) }, state, {
      actor: fighter.id,
      daysWithLessThanHalfWater: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.dc).toBe(15);
    expect(r.data?.saveRoll).toBe(5);
    expect(r.data?.saveSuccess).toBe(false);
    expect(r.data?.exhaustionApplied).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'add_condition',
        actorId: fighter.id,
        condition: {
          slug: 'exhaustion',
          source: 'dehydration',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);
  });

  it('1 day, success on natural 20 → no mutation', () => {
    const state = stateWith(baseFighter);
    const r = handleApplyDehydration({ rng: rngFor(20) }, state, {
      actor: baseFighter.id,
      daysWithLessThanHalfWater: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.saveSuccess).toBe(true);
    expect(r.data?.exhaustionApplied).toBe(false);
    expect(r.mutations).toEqual([]);
  });

  it('2 days → DC 20', () => {
    const fighter = { ...baseFighter, proficiencies: { ...baseFighter.proficiencies, saves: ['STR'] as const } } as Character;
    const state = stateWith(fighter);
    const r = handleApplyDehydration({ rng: rngFor(15) }, state, {
      actor: fighter.id,
      daysWithLessThanHalfWater: 2,
    });
    expect(r.data?.dc).toBe(20);
    expect(r.data?.saveSuccess).toBe(false);
    expect(r.data?.exhaustionApplied).toBe(true);
  });

  it('CON proficiency adds proficiency bonus', () => {
    // Fighter has CON saves prof. PB=2, CON 10 mod 0 → roll+2 total.
    const state = stateWith(baseFighter);
    const r = handleApplyDehydration({ rng: rngFor(13) }, state, {
      actor: baseFighter.id,
      daysWithLessThanHalfWater: 1, // DC 15
    });
    expect(r.data?.saveRoll).toBe(13);
    expect(r.data?.saveTotal).toBe(15); // 13 + 0 + 2
    expect(r.data?.saveSuccess).toBe(true);
  });

  it('unknown actor → unknown_character error', () => {
    const state = stateWith(baseFighter);
    const r = handleApplyDehydration({ rng: rngFor(5) }, state, {
      actor: 'ghost',
      daysWithLessThanHalfWater: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

// ─── Registry & tool definitions wiring ────────────────────────────────────

describe('TOOL_HANDLERS registry — survival tools', () => {
  it('forced_march wired and accepts player_character alias', () => {
    expect(TOOL_HANDLERS['forced_march']).toBeDefined();
    const state = stateWith(baseFighter);
    const r = TOOL_HANDLERS['forced_march']!(state, {
      actor: 'player_character',
      hoursTraveled: 8,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { dc: number }).dc).toBe(0);
  });

  it('forced_march rejects non-numeric hoursTraveled', () => {
    const state = stateWith(baseFighter);
    const r = TOOL_HANDLERS['forced_march']!(state, {
      actor: baseFighter.id,
      hoursTraveled: 'a lot',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_hours');
  });

  it('apply_starvation wired through the registry', () => {
    expect(TOOL_HANDLERS['apply_starvation']).toBeDefined();
    const state = stateWith(baseFighter);
    const r = TOOL_HANDLERS['apply_starvation']!(state, {
      actor: baseFighter.id,
      daysWithoutFood: 2,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { exhaustionApplied: boolean }).exhaustionApplied).toBe(false);
  });

  it('apply_starvation rejects non-numeric daysWithoutFood', () => {
    const state = stateWith(baseFighter);
    const r = TOOL_HANDLERS['apply_starvation']!(state, {
      actor: baseFighter.id,
      daysWithoutFood: 'many',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_days');
  });

  it('apply_dehydration wired through the registry', () => {
    expect(TOOL_HANDLERS['apply_dehydration']).toBeDefined();
    const state = stateWith(baseFighter);
    const r = TOOL_HANDLERS['apply_dehydration']!(state, {
      actor: baseFighter.id,
      daysWithLessThanHalfWater: 0,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { dc: number }).dc).toBe(0);
  });
});

describe('TOOL_DEFINITIONS — survival tools advertised', () => {
  it('forced_march tool definition exists with PHB §6.3 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'forced_march');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.3');
  });

  it('apply_starvation tool definition exists with PHB §6.7 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'apply_starvation');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.7');
  });

  it('apply_dehydration tool definition exists with PHB §6.7 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'apply_dehydration');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.7');
  });
});
