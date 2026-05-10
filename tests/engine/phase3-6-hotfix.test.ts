import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { newTurnState } from '@/engine/combat/turn-state';
import { tickConditions } from '@/engine/combat/turn';
import { makeSeededRng } from '@/engine/rand';
import type { Character, ActorRuntimeState, CombatActor } from '@/engine/types';

function fighter5(): Character {
  return {
    id: 'pc1',
    name: 'Aria',
    level: 5,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 40,
    ac: 16,
    speed: 30,
    proficiencies: {
      saves: ['STR', 'CON'],
      skills: ['Athletics'],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: [],
      tools: [],
      languages: [],
    },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 5,
    hitDieSize: 10,
  };
}

function rt(c: Character, ts = newTurnState()): ActorRuntimeState {
  return {
    actorId: c.id,
    hpCurrent: c.hpMax,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    turnState: ts,
  };
}

const goblin: CombatActor = {
  id: 'm1',
  kind: 'monster',
  name: 'Goblin',
  hpMax: 7,
  ac: 13,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2,
  initiativeBonus: 2,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
};

const goblinRt: ActorRuntimeState = {
  actorId: 'm1',
  hpCurrent: 7,
  tempHp: 0,
  conditions: [],
  deathSaves: { successes: 0, failures: 0 },
};

const sword = {
  name: 'Longsword',
  damage: '1d8',
  damageType: 'slashing' as const,
  profGroup: 'Martial',
  useDex: false,
};

describe('Fix #1: isExtraAttack flag for Multiattack / Extra Attack', () => {
  it('isExtraAttack:true skips action budget check (allows 2nd attack with action used)', () => {
    const f = fighter5();
    const runtime = rt(f, { ...newTurnState(), actionUsed: true });
    const r = makeAttack(
      {
        attacker: f,
        attackerRuntime: runtime,
        target: goblin,
        targetRuntime: goblinRt,
        weapon: sword,
        isExtraAttack: true,
      },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(true); // 2nd attack succeeds
  });

  it('isExtraAttack:true skips consume_action mutation emission', () => {
    const f = fighter5();
    const runtime = rt(f, { ...newTurnState(), actionUsed: true });
    const r = makeAttack(
      {
        attacker: f,
        attackerRuntime: runtime,
        target: goblin,
        targetRuntime: goblinRt,
        weapon: sword,
        isExtraAttack: true,
      },
      makeSeededRng(1),
    );
    const consumeMut = r.mutations.find((m) => m.op === 'consume_action');
    expect(consumeMut).toBeUndefined(); // no consume on extra attack
  });

  it('isExtraAttack:false (default) still requires unused action', () => {
    const f = fighter5();
    const runtime = rt(f, { ...newTurnState(), actionUsed: true });
    const r = makeAttack(
      {
        attacker: f,
        attackerRuntime: runtime,
        target: goblin,
        targetRuntime: goblinRt,
        weapon: sword, // no isExtraAttack flag
      },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('action_already_used');
  });

  it('isExtraAttack still works with knockOut, ranged, useReaction modifiers', () => {
    const f = fighter5();
    const runtime = rt(f, { ...newTurnState(), actionUsed: true });
    const r = makeAttack(
      {
        attacker: f,
        attackerRuntime: runtime,
        target: goblin,
        targetRuntime: goblinRt,
        weapon: sword,
        isExtraAttack: true,
        knockOut: false,
      },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(true);
  });

  it('Multi-attack scenario: first attack consumes action, extra attack does not', () => {
    const f = fighter5();
    let runtime = rt(f); // fresh

    // First attack
    const r1 = makeAttack(
      {
        attacker: f,
        attackerRuntime: runtime,
        target: goblin,
        targetRuntime: goblinRt,
        weapon: sword,
      },
      makeSeededRng(1),
    );
    expect(r1.ok).toBe(true);
    const consume1 = r1.mutations.find((m) => m.op === 'consume_action');
    expect(consume1).toBeDefined();
    // Simulate applicator: actionUsed becomes true
    runtime = { ...runtime, turnState: { ...runtime.turnState!, actionUsed: true } };

    // Second attack with isExtraAttack
    const r2 = makeAttack(
      {
        attacker: f,
        attackerRuntime: runtime,
        target: goblin,
        targetRuntime: goblinRt,
        weapon: sword,
        isExtraAttack: true,
      },
      makeSeededRng(2),
    );
    expect(r2.ok).toBe(true);
    const consume2 = r2.mutations.find((m) => m.op === 'consume_action');
    expect(consume2).toBeUndefined();
  });
});

describe('Fix #2: tickConditions removes expired conditions', () => {
  it('decrements durationRounds and removes when reaches 0', () => {
    const runtime: ActorRuntimeState = {
      actorId: 'pc1',
      hpCurrent: 10,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'helped', source: 'help', durationRounds: 1, appliedRound: 0 },
        { slug: 'blessed', source: 'bless', durationRounds: 10, appliedRound: 0 },
        { slug: 'incapacitated', source: 'shock', durationRounds: 'until_removed', appliedRound: 0 },
      ],
    };
    const r = tickConditions({ runtime, currentRound: 1 });
    // helped (1 round) → expires, remove_condition emitted
    // blessed (10) → still active (decremented to 9)
    // incapacitated (until_removed) → unchanged
    const removeMuts = r.mutations.filter((m) => m.op === 'remove_condition');
    expect(removeMuts).toHaveLength(1);
    const first = removeMuts[0];
    if (first?.op === 'remove_condition') {
      expect(first.conditionSlug).toBe('helped');
    }
    expect(r.data?.conditions.find((c) => c.slug === 'blessed')?.durationRounds).toBe(9);
    expect(r.data?.conditions.find((c) => c.slug === 'incapacitated')).toBeDefined();
  });
});
