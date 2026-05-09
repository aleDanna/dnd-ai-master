import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleApplyFalling,
  handleApplySuffocation,
  handleCheckVision,
  handleSetLightLevel,
  handleSetMarchingOrder,
  handleSetSenses,
  handleSetTravelPace,
} from '@/engine/tools/handlers';
import { TOOL_DEFINITIONS } from '@/engine/tools';
import type { Character, CombatActor, EngineState } from '@/engine/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const baseFighter: Character = {
  id: 'pc1',
  name: 'Tharion',
  level: 3,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 14, DEX: 12, CON: 12, INT: 10, WIS: 12, CHA: 8 },
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

const baseGoblin: CombatActor = {
  id: 'mob1',
  kind: 'monster',
  name: 'Goblin',
  monsterSlug: 'goblin',
  hpMax: 7,
  ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2,
  initiativeBonus: 2,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
  senses: { darkvisionFt: 60 },
};

function stateWith(
  char: Character,
  combatActors: CombatActor[] = [],
  travel?: EngineState['travel'],
): EngineState {
  return {
    characters: [char],
    combatActors,
    runtime: {
      [char.id]: {
        actorId: char.id,
        hpCurrent: char.hpMax,
        tempHp: 0,
        deathSaves: { successes: 0, failures: 0 },
        conditions: [],
      },
      ...Object.fromEntries(
        combatActors.map((a) => [
          a.id,
          {
            actorId: a.id,
            hpCurrent: a.hpMax,
            tempHp: 0,
            deathSaves: { successes: 0, failures: 0 },
            conditions: [],
          },
        ]),
      ),
    },
    combat: null,
    scene: '',
    travel,
  };
}

// rng helpers
function rngConst(value: number): () => number {
  return () => value;
}
function rngSeq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

// ─── set_travel_pace ──────────────────────────────────────────────────────

describe('handleSetTravelPace (PHB §6.1)', () => {
  it('emits set_travel_pace mutation for fast', () => {
    const r = handleSetTravelPace(stateWith(baseFighter), { pace: 'fast' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'set_travel_pace', pace: 'fast' }]);
  });

  it('emits set_travel_pace mutation for slow', () => {
    const r = handleSetTravelPace(stateWith(baseFighter), { pace: 'slow' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'set_travel_pace', pace: 'slow' }]);
  });

  it('rejects invalid pace', () => {
    const r = handleSetTravelPace(stateWith(baseFighter), { pace: 'sprinting' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_pace');
  });
});

// ─── set_light_level ──────────────────────────────────────────────────────

describe('handleSetLightLevel (PHB §6.4)', () => {
  it('emits set_light_level mutation for bright', () => {
    const r = handleSetLightLevel(stateWith(baseFighter), { lightLevel: 'bright' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'set_light_level', lightLevel: 'bright' }]);
  });

  it('rejects invalid level', () => {
    const r = handleSetLightLevel(stateWith(baseFighter), { lightLevel: 'twilight' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_light_level');
  });
});

// ─── set_marching_order ───────────────────────────────────────────────────

describe('handleSetMarchingOrder (PHB §6.2)', () => {
  it('emits set_marching_order mutation', () => {
    const order = { front: ['pc1'], middle: ['npc1'], back: ['scout'] };
    const r = handleSetMarchingOrder(stateWith(baseFighter), { order });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'set_marching_order', order }]);
  });

  it('rejects malformed order (missing arrays)', () => {
    const r = handleSetMarchingOrder(stateWith(baseFighter), {
      order: { front: ['x'] } as never,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_order');
  });
});

// ─── set_senses ───────────────────────────────────────────────────────────

describe('handleSetSenses (PHB §6.4)', () => {
  it('PC: emits set_senses mutation with correct actorId', () => {
    const r = handleSetSenses(stateWith(baseFighter), {
      actor: 'pc1',
      senses: { darkvisionFt: 60 },
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'set_senses', actorId: 'pc1', senses: { darkvisionFt: 60 } },
    ]);
  });

  it('combat actor: emits set_senses mutation', () => {
    const r = handleSetSenses(stateWith(baseFighter, [baseGoblin]), {
      actor: 'mob1',
      senses: { darkvisionFt: 90, blindsightFt: 10 },
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'set_senses',
        actorId: 'mob1',
        senses: { darkvisionFt: 90, blindsightFt: 10 },
      },
    ]);
  });

  it('player_character alias resolves to PC id', () => {
    const r = handleSetSenses(stateWith(baseFighter), {
      actor: 'player_character',
      senses: { darkvisionFt: 60 },
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({ actorId: 'pc1' });
  });

  it('unknown actor → unknown_actor', () => {
    const r = handleSetSenses(stateWith(baseFighter), {
      actor: 'ghost',
      senses: { darkvisionFt: 60 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });
});

// ─── check_vision ─────────────────────────────────────────────────────────

describe('handleCheckVision (PHB §6.4)', () => {
  it('bright light, plain sight → canSee, no DIS', () => {
    const fighter = { ...baseFighter };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
      senseUsed: 'sight',
      lightLevel: 'bright',
    });
  });

  it('dim light + 60ft darkvision: clear within 60ft', () => {
    const fighter = { ...baseFighter, senses: { darkvisionFt: 60 } };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 30,
      lightLevel: 'dim',
    });
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
      senseUsed: 'darkvision',
    });
  });

  it('dim light + 60ft darkvision: DIS beyond 60ft', () => {
    const fighter = { ...baseFighter, senses: { darkvisionFt: 60 } };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 90,
      lightLevel: 'dim',
    });
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
      senseUsed: 'sight',
    });
  });

  it('darkness, no senses → blinded', () => {
    const r = handleCheckVision(stateWith(baseFighter), {
      observer: baseFighter.id,
      distanceFt: 30,
      lightLevel: 'darkness',
    });
    expect(r.data).toMatchObject({
      canSee: false,
      perceptionDisadvantage: true,
      effectivelyBlinded: true,
      senseUsed: 'sight',
    });
  });

  it('darkness, darkvision in range → DIS but not blinded', () => {
    const fighter = { ...baseFighter, senses: { darkvisionFt: 60 } };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 30,
      lightLevel: 'darkness',
    });
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
      senseUsed: 'darkvision',
    });
  });

  it('blindsight bypasses darkness entirely', () => {
    const fighter = { ...baseFighter, senses: { blindsightFt: 30 } };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 25,
      lightLevel: 'darkness',
    });
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
      senseUsed: 'blindsight',
    });
  });

  it('tremorsense bypasses darkness entirely', () => {
    const fighter = { ...baseFighter, senses: { tremorsenseFt: 30 } };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 25,
      lightLevel: 'darkness',
    });
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
      senseUsed: 'tremorsense',
    });
  });

  it('truesight overrides darkness', () => {
    const fighter = { ...baseFighter, senses: { truesightFt: 60 } };
    const r = handleCheckVision(stateWith(fighter), {
      observer: fighter.id,
      distanceFt: 30,
      lightLevel: 'darkness',
    });
    expect(r.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
      senseUsed: 'truesight',
    });
  });

  it('lightLevel defaults to state.travel.lightLevel when omitted', () => {
    const fighter = { ...baseFighter, senses: { darkvisionFt: 60 } };
    const state = stateWith(fighter, [], { lightLevel: 'darkness' });
    const r = handleCheckVision(state, {
      observer: fighter.id,
      distanceFt: 30,
    });
    expect(r.data?.lightLevel).toBe('darkness');
    expect(r.data?.perceptionDisadvantage).toBe(true);
  });

  it('lightLevel falls back to bright when no travel state', () => {
    const r = handleCheckVision(stateWith(baseFighter), {
      observer: baseFighter.id,
      distanceFt: 30,
    });
    expect(r.data?.lightLevel).toBe('bright');
  });

  it('combat actor as observer is supported', () => {
    const goblin = { ...baseGoblin, senses: { darkvisionFt: 60 } };
    const r = handleCheckVision(stateWith(baseFighter, [goblin]), {
      observer: goblin.id,
      distanceFt: 30,
      lightLevel: 'darkness',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.senseUsed).toBe('darkvision');
  });

  it('unknown observer → unknown_observer error', () => {
    const r = handleCheckVision(stateWith(baseFighter), {
      observer: 'ghost',
      distanceFt: 30,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_observer');
  });

  it('emits no rolls and no mutations (pure)', () => {
    const r = handleCheckVision(stateWith(baseFighter), {
      observer: baseFighter.id,
      distanceFt: 30,
      lightLevel: 'dim',
    });
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });
});

// ─── apply_falling ────────────────────────────────────────────────────────

describe('handleApplyFalling (PHB §6.6)', () => {
  it('30ft fall: 3d6 bludgeoning + prone', () => {
    // Force every d6 to roll a 4 (rng=0.5 → floor(0.5*6)+1 = 4)
    const r = handleApplyFalling(
      { rng: rngConst(0.5) },
      stateWith(baseFighter),
      { actor: baseFighter.id, distanceFt: 30 },
    );
    expect(r.ok).toBe(true);
    expect(r.data?.dice).toBe(3);
    expect(r.data?.damage).toBe(12); // 3 * 4
    expect(r.data?.prone).toBe(true);
    expect(r.rolls).toHaveLength(1);
    expect(r.rolls[0]?.formula).toBe('3d6');
    expect(r.mutations).toEqual([
      { op: 'apply_damage', actorId: baseFighter.id, amount: 12, type: 'bludgeoning' },
      {
        op: 'add_condition',
        actorId: baseFighter.id,
        condition: {
          slug: 'prone',
          source: 'falling',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);
  });

  it('250ft fall: caps at 20d6 (max 120 dmg) + prone', () => {
    // rng=0.99 → floor(5.94)+1 = 6 per die → 20*6=120
    const r = handleApplyFalling(
      { rng: rngConst(0.99) },
      stateWith(baseFighter),
      { actor: baseFighter.id, distanceFt: 250 },
    );
    expect(r.data?.dice).toBe(20);
    expect(r.data?.damage).toBe(120);
    expect(r.data?.prone).toBe(true);
    expect(r.rolls[0]?.formula).toBe('20d6');
    expect(r.mutations[0]).toMatchObject({ op: 'apply_damage', amount: 120 });
  });

  it('5ft fall: no damage, not prone, no mutations', () => {
    const r = handleApplyFalling(
      { rng: rngConst(0.5) },
      stateWith(baseFighter),
      { actor: baseFighter.id, distanceFt: 5 },
    );
    expect(r.data).toEqual({ damage: 0, prone: false, dice: 0 });
    expect(r.mutations).toEqual([]);
    expect(r.rolls).toEqual([]);
  });

  it('combat actor as target works', () => {
    const r = handleApplyFalling(
      { rng: rngConst(0.5) },
      stateWith(baseFighter, [baseGoblin]),
      { actor: baseGoblin.id, distanceFt: 20 },
    );
    expect(r.data?.dice).toBe(2);
    expect(r.mutations[0]).toMatchObject({
      op: 'apply_damage',
      actorId: baseGoblin.id,
      type: 'bludgeoning',
    });
  });

  it('unknown actor → unknown_actor', () => {
    const r = handleApplyFalling(
      { rng: rngConst(0.5) },
      stateWith(baseFighter),
      { actor: 'ghost', distanceFt: 30 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('uses sequence rng to roll variable d6 values', () => {
    // 3 dice → rolls 1, 6, 4 → sum 11
    const r = handleApplyFalling(
      { rng: rngSeq([0.001, 0.999, 0.5]) },
      stateWith(baseFighter),
      { actor: baseFighter.id, distanceFt: 30 },
    );
    expect(r.rolls[0]?.rolls).toEqual([1, 6, 4]);
    expect(r.data?.damage).toBe(11);
  });
});

// ─── apply_suffocation ────────────────────────────────────────────────────

describe('handleApplySuffocation (PHB §6.5)', () => {
  // baseFighter has CON 12 → CON mod +1 → hold breath 120s, post-breath 1 round (6s)

  it('CON +1, 120s: status ok (within hold-breath, inclusive)', () => {
    const r = handleApplySuffocation(stateWith(baseFighter), {
      actor: baseFighter.id,
      secondsWithoutAir: 120,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.holdBreathSeconds).toBe(120);
    expect(r.data?.postBreathRounds).toBe(1);
    expect(r.data?.status).toBe('ok');
    expect(r.mutations).toEqual([]);
  });

  it('CON +1, 121s: past_breath (just past hold)', () => {
    const r = handleApplySuffocation(stateWith(baseFighter), {
      actor: baseFighter.id,
      secondsWithoutAir: 121,
    });
    expect(r.data?.status).toBe('past_breath');
    expect(r.mutations).toEqual([]);
  });

  it('CON +1, 126s (= 120 + 6): past_breath (final tick of post-breath round, inclusive)', () => {
    const r = handleApplySuffocation(stateWith(baseFighter), {
      actor: baseFighter.id,
      secondsWithoutAir: 126,
    });
    expect(r.data?.status).toBe('past_breath');
    expect(r.mutations).toEqual([]);
  });

  it('CON +1, 127s: unconscious (past both windows) → 0 HP + unconscious mutations', () => {
    const r = handleApplySuffocation(stateWith(baseFighter), {
      actor: baseFighter.id,
      secondsWithoutAir: 127,
    });
    expect(r.data?.status).toBe('unconscious');
    expect(r.mutations).toEqual([
      { op: 'set_hp', actorId: baseFighter.id, hpCurrent: 0 },
      {
        op: 'add_condition',
        actorId: baseFighter.id,
        condition: {
          slug: 'unconscious',
          source: 'suffocation',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);
  });

  it('CON +3 (16): hold-breath = 240s, post-breath = 3 rounds', () => {
    const tough = { ...baseFighter, abilities: { ...baseFighter.abilities, CON: 16 } };
    const r = handleApplySuffocation(stateWith(tough), {
      actor: tough.id,
      secondsWithoutAir: 240,
    });
    expect(r.data?.holdBreathSeconds).toBe(240);
    expect(r.data?.postBreathRounds).toBe(3);
    expect(r.data?.status).toBe('ok');
  });

  it('unknown character → unknown_character', () => {
    const r = handleApplySuffocation(stateWith(baseFighter), {
      actor: 'ghost',
      secondsWithoutAir: 60,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

// ─── Registry & tool definitions wiring ───────────────────────────────────

describe('TOOL_HANDLERS registry — exploration tools', () => {
  it('set_travel_pace wired', () => {
    expect(TOOL_HANDLERS['set_travel_pace']).toBeDefined();
    const r = TOOL_HANDLERS['set_travel_pace']!(stateWith(baseFighter), { pace: 'fast' });
    expect(r.ok).toBe(true);
  });

  it('set_light_level wired', () => {
    expect(TOOL_HANDLERS['set_light_level']).toBeDefined();
    const r = TOOL_HANDLERS['set_light_level']!(stateWith(baseFighter), { lightLevel: 'dim' });
    expect(r.ok).toBe(true);
  });

  it('set_marching_order wired', () => {
    expect(TOOL_HANDLERS['set_marching_order']).toBeDefined();
    const r = TOOL_HANDLERS['set_marching_order']!(stateWith(baseFighter), {
      order: { front: ['pc1'], middle: [], back: [] },
    });
    expect(r.ok).toBe(true);
  });

  it('set_senses wired with player_character alias', () => {
    expect(TOOL_HANDLERS['set_senses']).toBeDefined();
    const r = TOOL_HANDLERS['set_senses']!(stateWith(baseFighter), {
      actor: 'player_character',
      senses: { darkvisionFt: 60 },
    });
    expect(r.ok).toBe(true);
  });

  it('check_vision wired and pure', () => {
    expect(TOOL_HANDLERS['check_vision']).toBeDefined();
    const r = TOOL_HANDLERS['check_vision']!(stateWith(baseFighter), {
      observer: 'player_character',
      distanceFt: 30,
      lightLevel: 'dim',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([]);
  });

  it('check_vision rejects non-numeric distanceFt', () => {
    const r = TOOL_HANDLERS['check_vision']!(stateWith(baseFighter), {
      observer: 'player_character',
      distanceFt: 'far',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_distance');
  });

  it('apply_falling wired', () => {
    expect(TOOL_HANDLERS['apply_falling']).toBeDefined();
    const r = TOOL_HANDLERS['apply_falling']!(stateWith(baseFighter), {
      actor: 'player_character',
      distanceFt: 5,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { dice: number }).dice).toBe(0);
  });

  it('apply_suffocation wired', () => {
    expect(TOOL_HANDLERS['apply_suffocation']).toBeDefined();
    const r = TOOL_HANDLERS['apply_suffocation']!(stateWith(baseFighter), {
      actor: 'player_character',
      secondsWithoutAir: 30,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { status: string }).status).toBe('ok');
  });

  it('apply_suffocation rejects non-numeric seconds', () => {
    const r = TOOL_HANDLERS['apply_suffocation']!(stateWith(baseFighter), {
      actor: 'player_character',
      secondsWithoutAir: 'forever',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_seconds');
  });
});

describe('TOOL_DEFINITIONS — exploration tools advertised', () => {
  it('set_travel_pace defined with PHB §6.1 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'set_travel_pace');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.1');
  });

  it('set_light_level defined with PHB §6.4 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'set_light_level');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.4');
  });

  it('set_marching_order defined with PHB §6.2 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'set_marching_order');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.2');
  });

  it('set_senses defined with PHB §6.4 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'set_senses');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.4');
  });

  it('check_vision defined with PHB §6.4 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'check_vision');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.4');
  });

  it('apply_falling defined with PHB §6.6 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'apply_falling');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.6');
  });

  it('apply_suffocation defined with PHB §6.5 reference', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'apply_suffocation');
    expect(def).toBeDefined();
    expect(def?.description ?? '').toContain('§6.5');
  });
});
