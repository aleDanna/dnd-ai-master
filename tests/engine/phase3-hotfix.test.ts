import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { abilityCheck, savingThrow } from '@/engine/checks';
import { makeSeededRng } from '@/engine/rand';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  ConditionInstance,
} from '@/engine/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pcAttacker(): Character {
  return {
    id: 'pc1',
    name: 'Lyra',
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

function pcRuntime(c: Character, helped = false): ActorRuntimeState {
  const conditions: ConditionInstance[] = helped
    ? [{ slug: 'helped', source: 'help-action', durationRounds: 1, appliedRound: 0 }]
    : [];
  return {
    actorId: c.id,
    hpCurrent: c.hpMax,
    tempHp: 0,
    conditions,
    deathSaves: { successes: 0, failures: 0 },
    spellSlotsUsed: {},
    resourcesUsed: {},
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

function targetRt(): ActorRuntimeState {
  return {
    actorId: 'm1',
    hpCurrent: 7,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
  };
}

// ─── Issue #1: helped condition grants ADV ─────────────────────────────────

describe('Issue #1: helped condition grants ADV on attack', () => {
  it('helped attacker rolls 2d20 (ADV) on attack', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, true); // helped
    const r = makeAttack(
      {
        attacker: c,
        attackerRuntime: rt,
        target: goblin,
        targetRuntime: targetRt(),
        weapon: {
          name: 'Longsword',
          damage: '1d8',
          damageType: 'slashing',
          profGroup: 'Martial',
          useDex: false,
        },
      },
      makeSeededRng(1),
    );
    expect(r.rolls[0]?.rolls.length).toBe(2);
    expect(r.rolls[0]?.meta?.advantage).toBe(true);
  });

  it('helped condition is consumed (remove_condition mutation emitted) after attack — hit path', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, true);
    // Find a seed where the d20 (with ADV) hits AC 13
    let seed = 0;
    while (seed < 50) {
      const r = makeAttack(
        {
          attacker: c,
          attackerRuntime: rt,
          target: goblin,
          targetRuntime: targetRt(),
          weapon: {
            name: 'Longsword',
            damage: '1d8',
            damageType: 'slashing',
            profGroup: 'Martial',
            useDex: false,
          },
        },
        makeSeededRng(seed),
      );
      if (r.ok) {
        const removeMut = r.mutations.find(
          (m) => m.op === 'remove_condition' && m.conditionSlug === 'helped',
        );
        expect(removeMut).toBeDefined();
        if (removeMut?.op === 'remove_condition') {
          expect(removeMut.actorId).toBe(c.id);
        }
        return;
      }
      seed++;
    }
    throw new Error('No hit found in 50 seeds (with ADV)');
  });

  it('helped condition is consumed on miss too', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, true);
    // Use disadvantage to force miss path, but helped should still negate it (combine ADV+DIS = straight roll)
    // Actually, the cleanest is to use a target with very high AC for guaranteed miss.
    const wallTarget: CombatActor = { ...goblin, id: 'wall', ac: 99 };
    const r = makeAttack(
      {
        attacker: c,
        attackerRuntime: rt,
        target: wallTarget,
        targetRuntime: { ...targetRt(), actorId: 'wall' },
        weapon: {
          name: 'Longsword',
          damage: '1d8',
          damageType: 'slashing',
          profGroup: 'Martial',
          useDex: false,
        },
      },
      makeSeededRng(1),
    );
    expect(r.ok).toBe(false);
    const removeMut = r.mutations.find(
      (m) => m.op === 'remove_condition' && m.conditionSlug === 'helped',
    );
    expect(removeMut).toBeDefined();
  });

  it('non-helped attacker rolls 1d20 (no ADV), no remove_condition mutation', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, false); // not helped
    const r = makeAttack(
      {
        attacker: c,
        attackerRuntime: rt,
        target: goblin,
        targetRuntime: targetRt(),
        weapon: {
          name: 'Longsword',
          damage: '1d8',
          damageType: 'slashing',
          profGroup: 'Martial',
          useDex: false,
        },
      },
      makeSeededRng(1),
    );
    expect(r.rolls[0]?.rolls.length).toBe(1);
    const removeMut = r.mutations.find(
      (m) => m.op === 'remove_condition' && m.conditionSlug === 'helped',
    );
    expect(removeMut).toBeUndefined();
  });
});

describe('Issue #1: helped condition grants ADV on ability_check', () => {
  it('helped check rolls 2d20', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, true);
    const r = abilityCheck(
      {
        char: c,
        runtime: rt,
        ability: 'STR',
        skill: 'Athletics',
        dc: 15,
      },
      makeSeededRng(1),
    );
    expect(r.rolls[0]?.rolls.length).toBe(2);
    expect(r.rolls[0]?.meta?.advantage).toBe(true);
  });

  it('helped condition consumed after check (remove_condition mutation)', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, true);
    const r = abilityCheck(
      {
        char: c,
        runtime: rt,
        ability: 'STR',
        skill: 'Athletics',
        dc: 15,
      },
      makeSeededRng(1),
    );
    const removeMut = r.mutations.find(
      (m) => m.op === 'remove_condition' && m.conditionSlug === 'helped',
    );
    expect(removeMut).toBeDefined();
    if (removeMut?.op === 'remove_condition') {
      expect(removeMut.actorId).toBe(c.id);
    }
  });

  it('non-helped check rolls 1d20, no remove_condition', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, false);
    const r = abilityCheck(
      {
        char: c,
        runtime: rt,
        ability: 'STR',
        skill: 'Athletics',
        dc: 15,
      },
      makeSeededRng(1),
    );
    expect(r.rolls[0]?.rolls.length).toBe(1);
    const removeMut = r.mutations.find(
      (m) => m.op === 'remove_condition' && m.conditionSlug === 'helped',
    );
    expect(removeMut).toBeUndefined();
  });
});

describe('Issue #1: savingThrow is NOT modified by helped (PHB §3.5)', () => {
  it('helped does NOT grant ADV on a save', () => {
    const c = pcAttacker();
    const rt = pcRuntime(c, true);
    const r = savingThrow(
      {
        char: c,
        runtime: rt,
        ability: 'STR',
        dc: 15,
      },
      makeSeededRng(1),
    );
    // helped should NOT add ADV here per RAW (Help is for attacks/checks).
    expect(r.rolls[0]?.rolls.length).toBe(1);
    // and helped should NOT be consumed by a save.
    const removeMut = r.mutations.find(
      (m) => m.op === 'remove_condition' && m.conditionSlug === 'helped',
    );
    expect(removeMut).toBeUndefined();
  });
});

