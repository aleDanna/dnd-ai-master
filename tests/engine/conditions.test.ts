import { describe, it, expect } from 'vitest';
import { applyCondition, removeCondition } from '@/engine/conditions';
import type { ActorRuntimeState, CombatActor } from '@/engine/types';

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

const runtime: ActorRuntimeState = {
  actorId: 'm1', hpCurrent: 7, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [],
};

describe('applyCondition', () => {
  it('emits add_condition mutation', () => {
    const r = applyCondition({ target: goblin, runtime, condition: { slug: 'poisoned', source: 'spider bite', durationRounds: 3, appliedRound: 1 } });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('add_condition');
  });

  it('respects target conditionImmunities', () => {
    const immune: CombatActor = { ...goblin, conditionImmunities: ['poisoned'] };
    const r = applyCondition({ target: immune, runtime, condition: { slug: 'poisoned', source: 'x', durationRounds: 1, appliedRound: 1 } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('immune');
    expect(r.mutations.length).toBe(0);
  });

  it('does not duplicate same condition (idempotent)', () => {
    const withPoison: ActorRuntimeState = {
      ...runtime,
      conditions: [{ slug: 'poisoned', source: 'a', durationRounds: 1, appliedRound: 1 }],
    };
    const r = applyCondition({ target: goblin, runtime: withPoison, condition: { slug: 'poisoned', source: 'b', durationRounds: 5, appliedRound: 2 } });
    expect(r.mutations.length).toBe(1);                // updated, not duplicated
    expect(r.data?.replaced).toBe(true);
  });
});

describe('removeCondition', () => {
  it('emits remove_condition mutation', () => {
    const withPoison: ActorRuntimeState = {
      ...runtime,
      conditions: [{ slug: 'poisoned', source: 'a', durationRounds: 1, appliedRound: 1 }],
    };
    const r = removeCondition({ runtime: withPoison, conditionSlug: 'poisoned' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('remove_condition');
  });

  it('no-op if not present', () => {
    const r = removeCondition({ runtime, conditionSlug: 'poisoned' });
    expect(r.ok).toBe(true);
    expect(r.mutations.length).toBe(0);
  });
});
