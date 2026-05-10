import { describe, expect, it } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { castSpell } from '@/engine/spells';
import { resolveStandardAction } from '@/engine/combat/standard-actions';
import { resolveMove } from '@/engine/combat/movement';
import { endTurn } from '@/engine/combat/turn';
import { newTurnState, consumeAction, spendMovement } from '@/engine/combat/turn-state';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  EngineState,
  Mutation,
  Position,
  TurnState,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// The production applicator is DB-backed (Drizzle transactions). For these
// E2E scenarios we drive the same mutation set against an in-memory
// EngineState so we can exercise the full action-economy chain without
// spinning up a database. Mutation semantics MUST match the DB applicator —
// keep in lockstep with src/sessions/applicator.ts. Mirrors the pattern
// from death-save-loop and concentration-loop, extended with the action-
// economy ops added in Phase 3 (start_turn, consume_action,
// consume_movement, take_dodge/disengage/dash, set_readied, set_position,
// opportunity_attack_triggered).
function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = { ...state, runtime: { ...state.runtime } };
  switch (m.op) {
    case 'apply_damage': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, hpCurrent: Math.max(0, rt.hpCurrent - m.amount) };
      break;
    }
    case 'set_hp': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, hpCurrent: m.hpCurrent };
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
    case 'use_spell_slot': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const used = { ...(rt.spellSlotsUsed ?? {}) };
      used[m.level] = (used[m.level] ?? 0) + 1;
      next.runtime[m.actorId] = { ...rt, spellSlotsUsed: used };
      break;
    }
    case 'start_turn': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, turnState: newTurnState() };
      break;
    }
    case 'consume_action': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: consumeAction(ts, m.kind) };
      break;
    }
    case 'consume_movement': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: spendMovement(ts, m.feet) };
      break;
    }
    case 'take_dodge': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: { ...ts, dodging: true } };
      break;
    }
    case 'take_disengage': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: { ...ts, disengaged: true } };
      break;
    }
    case 'take_dash': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: { ...ts, dashed: true } };
      break;
    }
    case 'set_readied': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = {
        ...rt,
        turnState: { ...ts, readied: { trigger: m.trigger, action: m.action } },
      };
      break;
    }
    case 'set_position': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, position: m.position };
      break;
    }
    case 'opportunity_attack_triggered': {
      // Signal-only; OA resolution is downstream. No state change here.
      break;
    }
    case 'advance_turn': {
      // The DB applicator advances combat.currentIdx; mirror minimally.
      if (!next.combat) break;
      const { turnOrder, currentIdx, round } = next.combat;
      const isLast = currentIdx >= turnOrder.length - 1;
      next.combat = {
        ...next.combat,
        currentIdx: isLast ? 0 : currentIdx + 1,
        round: isLast ? round + 1 : round,
      };
      break;
    }
    default:
      // Other ops (heal, set_concentration, etc.) aren't exercised here —
      // pass through unchanged. Matches the silent-fallthrough convention
      // of the sibling scenario tests.
      break;
  }
  return next;
}

function applyMutations(state: EngineState, muts: Mutation[]): EngineState {
  return muts.reduce(applyMutation, state);
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

function pcCharacter(opts: { id?: string; level?: number; speed?: number; spellsKnown?: string[] } = {}): Character {
  return {
    id: opts.id ?? 'pc1',
    name: 'Lyra',
    level: opts.level ?? 5,
    xp: 0,
    classSlug: 'wizard',
    raceSlug: 'high-elf',
    backgroundSlug: 'sage',
    abilities: { STR: 10, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 30,
    ac: 14,
    speed: opts.speed ?? 30,
    proficiencies: {
      saves: ['INT', 'WIS'],
      skills: [],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: [],
      tools: [],
      languages: [],
    },
    spellcasting: {
      ability: 'INT',
      spellSaveDC: 14,
      spellAttackBonus: 6,
      slotsMax: { 1: 4, 2: 3, 3: 2 },
      spellsKnown: opts.spellsKnown ?? ['fire-bolt', 'cure-wounds', 'healing-word'],
      spellsPrepared: [],
    },
    features: [],
    inventory: [],
    hitDiceMax: opts.level ?? 5,
    hitDieSize: 6,
  };
}

function pcRuntime(
  c: Character,
  overrides: { turnState?: TurnState; position?: Position } = {},
): ActorRuntimeState {
  return {
    actorId: c.id,
    hpCurrent: c.hpMax,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    spellSlotsUsed: {},
    resourcesUsed: {},
    ...overrides,
  };
}

function goblin(opts: { id?: string; hpMax?: number } = {}): CombatActor {
  return {
    id: opts.id ?? 'm1',
    kind: 'monster',
    name: 'Goblin',
    hpMax: opts.hpMax ?? 7,
    ac: 13,
    abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2,
    initiativeBonus: 2,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
  };
}

function goblinRuntime(
  g: CombatActor,
  overrides: { turnState?: TurnState; position?: Position } = {},
): ActorRuntimeState {
  return {
    actorId: g.id,
    hpCurrent: g.hpMax,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    ...overrides,
  };
}

/**
 * Build a Character-shaped goblin for the dodge scenario, where makeAttack's
 * `attacker` parameter is typed as `Character`. The attack tests in the suite
 * all use a PC attacker; using a Character here keeps `attackBonus()` (which
 * reads `proficiencies.weapons`) happy.
 */
function goblinAsCharacter(opts: { id?: string } = {}): Character {
  return {
    id: opts.id ?? 'm1',
    name: 'Goblin',
    level: 1,
    xp: 0,
    classSlug: 'monster',
    raceSlug: 'goblinoid',
    backgroundSlug: 'none',
    abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2,
    hpMax: 7,
    ac: 13,
    speed: 30,
    proficiencies: {
      saves: [],
      skills: [],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: [],
      tools: [],
      languages: [],
    },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 1,
    hitDieSize: 6,
  };
}

function buildState(
  pc: Character,
  pcRt: ActorRuntimeState,
  monsters: { actor: CombatActor; runtime: ActorRuntimeState }[],
): EngineState {
  return {
    characters: [pc],
    combatActors: monsters.map((m) => m.actor),
    runtime: {
      [pc.id]: pcRt,
      ...Object.fromEntries(monsters.map((m) => [m.actor.id, m.runtime])),
    },
    combat: {
      round: 1,
      currentIdx: 0,
      turnOrder: [
        { actorId: pc.id, initiative: 15 },
        ...monsters.map((m, i) => ({ actorId: m.actor.id, initiative: 10 - i })),
      ],
    },
    scene: 'dungeon corridor',
  };
}

// ─── E2E scenarios ─────────────────────────────────────────────────────────

const SHORTSWORD = {
  name: 'Shortsword',
  damage: '1d6',
  damageType: 'piercing' as const,
  profGroup: 'Martial',
  useDex: true,
};

const SCIMITAR = {
  name: 'Scimitar',
  damage: '1d6',
  damageType: 'slashing' as const,
  profGroup: 'Martial',
  useDex: true,
};

describe('E2E — action economy', () => {
  it('PC attacks (consumes action), then moves out of engagement (triggers OA on enemy)', () => {
    const pc = pcCharacter();
    const pcRt = pcRuntime(pc, {
      turnState: newTurnState(),
      position: { band: 'engaged', engagedWith: ['m1'] },
    });
    const m1 = goblin();
    const m1Rt = goblinRuntime(m1, {
      turnState: newTurnState(),
      position: { band: 'engaged', engagedWith: [pc.id] },
    });
    let state = buildState(pc, pcRt, [{ actor: m1, runtime: m1Rt }]);

    // 1. PC attacks goblin with a shortsword. The action-economy guard
    //    consumes the PC's action regardless of hit/miss outcome.
    const atk = makeAttack({
      attacker: pc,
      attackerRuntime: state.runtime[pc.id]!,
      target: m1,
      targetRuntime: state.runtime[m1.id]!,
      weapon: SHORTSWORD,
    });
    state = applyMutations(state, atk.mutations);
    expect(state.runtime[pc.id]!.turnState?.actionUsed).toBe(true);

    // 2. PC moves to 'near', leaving engagement with goblin.
    const mv = resolveMove(
      { actorId: pc.id, toBand: 'near', leavesEngagementWith: ['m1'] },
      state.runtime[pc.id],
      pc.speed,
    );
    expect(mv.ok).toBe(true);
    state = applyMutations(state, mv.mutations);
    expect(state.runtime[pc.id]!.position?.band).toBe('near');

    // 3. Movement leaving engagement → OA mutation emitted, goblin is the attacker.
    const oa = mv.mutations.find((mut) => mut.op === 'opportunity_attack_triggered');
    expect(oa).toBeDefined();
    if (oa?.op === 'opportunity_attack_triggered') {
      expect(oa.attackerId).toBe('m1');
      expect(oa.targetId).toBe(pc.id);
    }
  });

  it('PC uses Disengage then moves out — no OA', () => {
    const pc = pcCharacter();
    const pcRt = pcRuntime(pc, {
      turnState: newTurnState(),
      position: { band: 'engaged', engagedWith: ['m1'] },
    });
    const m1 = goblin();
    const m1Rt = goblinRuntime(m1);
    let state = buildState(pc, pcRt, [{ actor: m1, runtime: m1Rt }]);

    // 1. PC takes Disengage as their action.
    const dis = resolveStandardAction(
      { actorId: pc.id, kind: 'disengage' },
      state.runtime[pc.id],
    );
    expect(dis.ok).toBe(true);
    state = applyMutations(state, dis.mutations);
    expect(state.runtime[pc.id]!.turnState?.disengaged).toBe(true);

    // 2. PC moves out of engagement — no OA because disengaged.
    const mv = resolveMove(
      { actorId: pc.id, toBand: 'near', leavesEngagementWith: ['m1'] },
      state.runtime[pc.id],
      pc.speed,
    );
    expect(mv.ok).toBe(true);
    state = applyMutations(state, mv.mutations);
    const oa = mv.mutations.find((mut) => mut.op === 'opportunity_attack_triggered');
    expect(oa).toBeUndefined();
  });

  it('PC dashes, can move 60ft (2× speed); 85ft transition refused, 50ft transition allowed', () => {
    const pc = pcCharacter({ speed: 30 });
    const pcRt = pcRuntime(pc, {
      turnState: newTurnState(),
      position: { band: 'near', engagedWith: [] },
    });
    let state = buildState(pc, pcRt, []);

    // 1. Dash → dashed flag set, action consumed.
    const dash = resolveStandardAction(
      { actorId: pc.id, kind: 'dash' },
      state.runtime[pc.id],
    );
    expect(dash.ok).toBe(true);
    state = applyMutations(state, dash.mutations);
    expect(state.runtime[pc.id]!.turnState?.dashed).toBe(true);

    // 2. near → distant = 25 + 60 = 85 ft. With 60 ft budget (30×2) → fail.
    const farMove = resolveMove(
      { actorId: pc.id, toBand: 'distant' },
      state.runtime[pc.id],
      pc.speed,
    );
    expect(farMove.ok).toBe(false);
    expect(farMove.error).toBe('insufficient_movement');

    // 3. near → far = 25 ft → fits in budget, succeeds.
    const okMove = resolveMove(
      { actorId: pc.id, toBand: 'far' },
      state.runtime[pc.id],
      pc.speed,
    );
    expect(okMove.ok).toBe(true);
  });

  it('Bonus-action healing-word then leveled cure-wounds errors with bonus_action_spell_rule', () => {
    const pc = pcCharacter({ spellsKnown: ['healing-word', 'cure-wounds'] });
    const pcRt = pcRuntime(pc, { turnState: newTurnState() });
    let state = buildState(pc, pcRt, []);

    // 1. Cast healing-word as a bonus action.
    const cast1 = castSpell(
      {
        caster: pc,
        runtime: state.runtime[pc.id]!,
        spellSlug: 'healing-word',
        slotLevel: 1,
        targets: [{ id: pc.id }],
        spellMeta: { castingTime: '1 bonus action' },
      },
      () => 0.5,
    );
    expect(cast1.ok).toBe(true);
    state = applyMutations(state, cast1.mutations);
    expect(state.runtime[pc.id]!.turnState?.bonusUsed).toBe(true);

    // 2. Try cure-wounds (1 action, leveled, not cantrip) → bonus_action_spell_rule.
    const cast2 = castSpell(
      {
        caster: pc,
        runtime: state.runtime[pc.id]!,
        spellSlug: 'cure-wounds',
        slotLevel: 1,
        targets: [{ id: pc.id }],
        spellMeta: { castingTime: '1 action' },
      },
      () => 0.5,
    );
    expect(cast2.ok).toBe(false);
    expect(cast2.error).toBe('bonus_action_spell_rule');
  });

  it('Bonus-action spell + 1-action cantrip is allowed (PHB §8.5 cantrip exception)', () => {
    const pc = pcCharacter({ spellsKnown: ['healing-word', 'fire-bolt'] });
    const pcRt = pcRuntime(pc, { turnState: newTurnState() });
    const m1 = goblin();
    const m1Rt = goblinRuntime(m1);
    let state = buildState(pc, pcRt, [{ actor: m1, runtime: m1Rt }]);

    // 1. healing-word as bonus action.
    const c1 = castSpell(
      {
        caster: pc,
        runtime: state.runtime[pc.id]!,
        spellSlug: 'healing-word',
        slotLevel: 1,
        targets: [{ id: pc.id }],
        spellMeta: { castingTime: '1 bonus action' },
      },
      () => 0.5,
    );
    expect(c1.ok).toBe(true);
    state = applyMutations(state, c1.mutations);
    expect(state.runtime[pc.id]!.turnState?.bonusUsed).toBe(true);

    // 2. fire-bolt (cantrip, 1 action) → OK.
    const c2 = castSpell(
      {
        caster: pc,
        runtime: state.runtime[pc.id]!,
        spellSlug: 'fire-bolt',
        slotLevel: 0,
        targets: [{ id: 'm1', ac: 10 }],
        spellMeta: { castingTime: '1 action' },
      },
      () => 0.5,
    );
    expect(c2.ok).toBe(true);
  });

  it('PC dodges → attacker rolls with disadvantage', () => {
    const pc = pcCharacter();
    const pcRt = pcRuntime(pc, { turnState: newTurnState() });
    const m1 = goblin();
    const m1Rt = goblinRuntime(m1, { turnState: newTurnState() });
    let state = buildState(pc, pcRt, [{ actor: m1, runtime: m1Rt }]);

    // 1. PC takes Dodge.
    const dodge = resolveStandardAction(
      { actorId: pc.id, kind: 'dodge' },
      state.runtime[pc.id],
    );
    expect(dodge.ok).toBe(true);
    state = applyMutations(state, dodge.mutations);
    expect(state.runtime[pc.id]!.turnState?.dodging).toBe(true);

    // 2. Goblin attacks dodging PC → DIS → 2 d20s rolled.
    const goblinChar = goblinAsCharacter({ id: m1.id });
    const pcAsTarget: CombatActor = {
      id: pc.id,
      kind: 'pc',
      name: pc.name,
      hpMax: pc.hpMax,
      ac: pc.ac,
      abilities: pc.abilities,
      proficiencyBonus: pc.proficiencyBonus,
      initiativeBonus: 2,
      resistances: [],
      immunities: [],
      vulnerabilities: [],
      conditionImmunities: [],
    };
    const atk = makeAttack({
      attacker: goblinChar,
      attackerRuntime: state.runtime[m1.id]!,
      target: pcAsTarget,
      targetRuntime: state.runtime[pc.id]!,
      weapon: SCIMITAR,
    });
    // The first roll is the d20 attack roll; with DIS it has 2 dice.
    expect(atk.rolls[0]?.rolls.length).toBe(2);
  });

  it('endTurn emits start_turn for next actor; turnState resets on apply', () => {
    const pc = pcCharacter();
    const pcRt = pcRuntime(pc, {
      turnState: { ...newTurnState(), actionUsed: true, dashed: true },
    });
    const m1 = goblin();
    const m1Rt = goblinRuntime(m1);
    let state = buildState(pc, pcRt, [{ actor: m1, runtime: m1Rt }]);

    const result = endTurn({ combat: state.combat! });
    expect(result.ok).toBe(true);
    expect(result.data?.nextActorId).toBe(m1.id);
    state = applyMutations(state, result.mutations);

    // start_turn for m1 reset their turnState to a fresh budget.
    expect(state.runtime[m1.id]!.turnState).toEqual(newTurnState());
  });

  it("Help grants 'helped' condition on beneficiary with currentRound stamped", () => {
    const pc1 = pcCharacter({ id: 'pc1' });
    const pc2 = pcCharacter({ id: 'pc2' });
    const pc1Rt = pcRuntime(pc1, { turnState: newTurnState() });
    const pc2Rt = pcRuntime(pc2);
    let state: EngineState = {
      characters: [pc1, pc2],
      combatActors: [],
      runtime: { [pc1.id]: pc1Rt, [pc2.id]: pc2Rt },
      combat: {
        round: 4,
        currentIdx: 0,
        turnOrder: [
          { actorId: pc1.id, initiative: 15 },
          { actorId: pc2.id, initiative: 12 },
        ],
      },
      scene: 'dungeon corridor',
    };

    const help = resolveStandardAction(
      {
        actorId: pc1.id,
        kind: 'help',
        beneficiaryId: pc2.id,
        currentRound: state.combat?.round,
      },
      state.runtime[pc1.id],
    );
    expect(help.ok).toBe(true);
    state = applyMutations(state, help.mutations);

    const helpedCond = state.runtime[pc2.id]!.conditions.find((c) => c.slug === 'helped');
    expect(helpedCond).toBeDefined();
    expect(helpedCond?.appliedRound).toBe(4);
  });
});
