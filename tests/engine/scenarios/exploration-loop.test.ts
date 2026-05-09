import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleApplyFalling,
  handleApplySuffocation,
  handleCheckVision,
} from '@/engine/tools/handlers';
import { TRAVEL_PACES } from '@/engine/exploration';
import { passiveScore } from '@/engine/modifiers';
import type {
  Character,
  ConditionInstance,
  EngineState,
  Mutation,
  TravelState,
} from '@/engine/types';

// ─── In-memory applicator scoped to exploration mutations ─────────────────
// Mirrors the relevant cases from src/sessions/applicator.ts. Other ops
// fall through unchanged so this driver can be combined with the existing
// scenarios without divergence.

interface ScenarioState extends EngineState {
  travel?: TravelState;
}

function applyMutation(state: ScenarioState, m: Mutation): ScenarioState {
  const next: ScenarioState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({ ...c })),
    combatActors: state.combatActors.map((a) => ({ ...a })),
    travel: state.travel ? { ...state.travel } : undefined,
  };
  switch (m.op) {
    case 'set_hp': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, hpCurrent: m.hpCurrent };
      break;
    }
    case 'apply_damage': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = {
        ...rt,
        hpCurrent: Math.max(0, rt.hpCurrent - m.amount),
      };
      break;
    }
    case 'add_condition': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const conds = rt.conditions.filter((c) => c.slug !== m.condition.slug);
      conds.push(m.condition);
      next.runtime[m.actorId] = { ...rt, conditions: conds };
      break;
    }
    case 'set_travel_pace':
    case 'set_light_level':
    case 'set_marching_order': {
      const cur: TravelState = next.travel ?? {};
      if (m.op === 'set_travel_pace') {
        next.travel = { ...cur, pace: m.pace };
      } else if (m.op === 'set_light_level') {
        next.travel = { ...cur, lightLevel: m.lightLevel };
      } else {
        next.travel = { ...cur, marchingOrder: m.order };
      }
      break;
    }
    case 'set_senses': {
      const charIdx = next.characters.findIndex((c) => c.id === m.actorId);
      if (charIdx >= 0) {
        next.characters[charIdx] = { ...next.characters[charIdx]!, senses: m.senses };
        break;
      }
      const actorIdx = next.combatActors.findIndex((a) => a.id === m.actorId);
      if (actorIdx >= 0) {
        next.combatActors[actorIdx] = { ...next.combatActors[actorIdx]!, senses: m.senses };
      }
      break;
    }
    default:
      break;
  }
  return next;
}

function applyAll(state: ScenarioState, mutations: Mutation[]): ScenarioState {
  return mutations.reduce(applyMutation, state);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const ranger: Character = {
  id: 'pc1',
  name: 'Lirien',
  level: 3,
  xp: 0,
  classSlug: 'ranger',
  raceSlug: 'half-elf',
  backgroundSlug: 'outlander',
  abilities: { STR: 12, DEX: 16, CON: 12, INT: 10, WIS: 14, CHA: 10 },
  proficiencyBonus: 2,
  hpMax: 24,
  ac: 15,
  speed: 30,
  proficiencies: {
    saves: ['STR', 'DEX'],
    skills: ['Perception', 'Stealth', 'Survival'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Shield'],
    tools: [],
    languages: ['Common', 'Elvish'],
  },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 3,
  hitDieSize: 10,
};

function freshState(): ScenarioState {
  return {
    characters: [ranger],
    combatActors: [],
    runtime: {
      [ranger.id]: {
        actorId: ranger.id,
        hpCurrent: ranger.hpMax,
        tempHp: 0,
        deathSaves: { successes: 0, failures: 0 },
        conditions: [],
      },
    },
    combat: null,
    scene: 'overland trek',
  };
}

// rng helpers
function rngConst(value: number): () => number {
  return () => value;
}

// ─── Scenario 1: Travel pace transitions ──────────────────────────────────

describe('exploration loop — travel pace transitions (PHB §6.1)', () => {
  it('Fast → Slow updates the persisted pace and matches PHB pacing data', () => {
    let state = freshState();

    // Confirm passive Perception derived from skill.
    const passiveBaseline = passiveScore(ranger, 'Perception');
    expect(passiveBaseline).toBe(14); // 10 + WIS+2 + prof+2

    // Set Fast pace → -5 narrative modifier captured in TRAVEL_PACES.
    let r = TOOL_HANDLERS['set_travel_pace']!(state, { pace: 'fast' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.travel?.pace).toBe('fast');
    expect(TRAVEL_PACES.fast.passivePerceptionMod).toBe(-5);
    expect(passiveBaseline + TRAVEL_PACES.fast.passivePerceptionMod).toBe(9);

    // Switch to Slow. Stealth allowed; -5 modifier removed.
    r = TOOL_HANDLERS['set_travel_pace']!(state, { pace: 'slow' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.travel?.pace).toBe('slow');
    expect(TRAVEL_PACES.slow.stealthAllowed).toBe(true);
    expect(passiveBaseline + TRAVEL_PACES.slow.passivePerceptionMod).toBe(passiveBaseline);
  });
});

// ─── Scenario 2: Vision — dim + 60ft darkvision ───────────────────────────

describe('exploration loop — vision under dim light with darkvision (PHB §6.4)', () => {
  it('darkvision PC: clear within 60ft, DIS beyond 60ft', () => {
    let state = freshState();

    // Step 1: master sets the scene's light to dim and grants the PC darkvision.
    let r = TOOL_HANDLERS['set_light_level']!(state, { lightLevel: 'dim' });
    state = applyAll(state, r.mutations);

    r = TOOL_HANDLERS['set_senses']!(state, {
      actor: ranger.id,
      senses: { darkvisionFt: 60 },
    });
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.senses).toEqual({ darkvisionFt: 60 });

    // Within darkvision range: no penalty (dim treated as bright).
    const within = handleCheckVision(state, {
      observer: ranger.id,
      distanceFt: 30,
    });
    expect(within.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: false,
      effectivelyBlinded: false,
      senseUsed: 'darkvision',
      lightLevel: 'dim',
    });

    // Beyond darkvision: DIS on Perception (still treats as dim → light obscure).
    const beyond = handleCheckVision(state, {
      observer: ranger.id,
      distanceFt: 90,
    });
    expect(beyond.data).toMatchObject({
      canSee: true,
      perceptionDisadvantage: true,
      effectivelyBlinded: false,
      senseUsed: 'sight',
    });

    // Both calls must be pure (no mutations).
    expect(within.mutations).toEqual([]);
    expect(beyond.mutations).toEqual([]);
  });
});

// ─── Scenario 3: Falling 30ft → 3d6 + prone ───────────────────────────────

describe('exploration loop — falling 30ft (PHB §6.6)', () => {
  it('PC falls 30ft: 3d6 bludgeoning + prone applied to runtime', () => {
    let state = freshState();
    // rng=0.5 → every d6 rolls 4 → total 12 over 3d6.
    const r = handleApplyFalling(
      { rng: rngConst(0.5) },
      state,
      { actor: ranger.id, distanceFt: 30 },
    );
    expect(r.ok).toBe(true);
    expect(r.data?.dice).toBe(3);
    expect(r.data?.damage).toBe(12);
    expect(r.data?.prone).toBe(true);

    state = applyAll(state, r.mutations);

    // Verify HP was reduced and prone applied.
    expect(state.runtime[ranger.id]!.hpCurrent).toBe(ranger.hpMax - 12);
    const conds = state.runtime[ranger.id]!.conditions as ConditionInstance[];
    expect(conds.some((c) => c.slug === 'prone' && c.source === 'falling')).toBe(true);
  });
});

// ─── Scenario 4: Falling 250ft → cap 20d6 + prone ─────────────────────────

describe('exploration loop — falling 250ft caps at 20d6 (PHB §6.6)', () => {
  it('PC falls 250ft: rolls 20d6 (the cap), prone applied', () => {
    let state = freshState();
    // rng=0.999 → every d6 rolls 6 → total 120 over 20d6.
    const r = handleApplyFalling(
      { rng: rngConst(0.999) },
      state,
      { actor: ranger.id, distanceFt: 250 },
    );
    expect(r.data?.dice).toBe(20);
    expect(r.data?.damage).toBe(120);
    expect(r.rolls[0]?.formula).toBe('20d6');

    state = applyAll(state, r.mutations);
    // 24 - 120 → clamped to 0 by applyMutation.
    expect(state.runtime[ranger.id]!.hpCurrent).toBe(0);
    const conds = state.runtime[ranger.id]!.conditions as ConditionInstance[];
    expect(conds.some((c) => c.slug === 'prone')).toBe(true);
  });
});

// ─── Scenario 5: Suffocation (CON +1) ─────────────────────────────────────

describe('exploration loop — suffocation thresholds (PHB §6.5)', () => {
  it('CON +1: 120s ok, 130s past_breath, 142s unconscious', () => {
    // ranger has CON 12 → mod +1
    let state = freshState();

    // 120s: still within hold-breath → ok, no mutation.
    const r1 = handleApplySuffocation(state, {
      actor: ranger.id,
      secondsWithoutAir: 120,
    });
    expect(r1.data?.holdBreathSeconds).toBe(120);
    expect(r1.data?.postBreathRounds).toBe(1);
    expect(r1.data?.status).toBe('ok');
    expect(r1.mutations).toEqual([]);

    // 130s: past hold (120) but still within post-breath round (1 round = 6s).
    // hold + post = 120 + 6 = 126 ⇒ 130 is past both windows ⇒ unconscious!
    // Re-checking: at 121-126 secondsWithoutAir → past_breath; 127+ → unconscious.
    // The plan says 130 = past_breath, but that's only true if we widen the
    // post-breath window. Per the rule, post-breath is `CON mod` rounds,
    // 1 round = 6 sec. CON +1 → 1 round → 6 sec. So 121-126 is past_breath
    // and 127+ is unconscious. We cover both branches separately to keep
    // the assertions tight against the rule.
    const r130 = handleApplySuffocation(state, {
      actor: ranger.id,
      secondsWithoutAir: 130,
    });
    expect(r130.data?.status).toBe('unconscious');

    // Use 124 (within post-breath window) for the past_breath assertion.
    const rPast = handleApplySuffocation(state, {
      actor: ranger.id,
      secondsWithoutAir: 124,
    });
    expect(rPast.data?.status).toBe('past_breath');
    expect(rPast.mutations).toEqual([]);

    // 142s: well past both windows → unconscious mutations applied.
    const r142 = handleApplySuffocation(state, {
      actor: ranger.id,
      secondsWithoutAir: 142,
    });
    expect(r142.data?.status).toBe('unconscious');
    state = applyAll(state, r142.mutations);
    expect(state.runtime[ranger.id]!.hpCurrent).toBe(0);
    const conds = state.runtime[ranger.id]!.conditions as ConditionInstance[];
    expect(
      conds.some((c) => c.slug === 'unconscious' && c.source === 'suffocation'),
    ).toBe(true);
  });
});

// ─── Bonus: marching order persists across pace and light changes ─────────

describe('exploration loop — marching order survives unrelated travel updates', () => {
  it('set_marching_order then set_light_level keeps the ranks intact', () => {
    let state = freshState();
    const order = { front: ['pc1'], middle: ['npc1'], back: ['scout'] };

    let r = TOOL_HANDLERS['set_marching_order']!(state, { order });
    state = applyAll(state, r.mutations);
    expect(state.travel?.marchingOrder).toEqual(order);

    r = TOOL_HANDLERS['set_light_level']!(state, { lightLevel: 'dim' });
    state = applyAll(state, r.mutations);
    expect(state.travel?.marchingOrder).toEqual(order);
    expect(state.travel?.lightLevel).toBe('dim');

    r = TOOL_HANDLERS['set_travel_pace']!(state, { pace: 'slow' });
    state = applyAll(state, r.mutations);
    expect(state.travel).toEqual({
      marchingOrder: order,
      lightLevel: 'dim',
      pace: 'slow',
    });
  });
});
