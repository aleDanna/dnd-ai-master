import { describe, it, expect } from 'vitest';
import { endTurn, tickConditions } from '@/engine/combat/turn';
import type { CombatState, ActorRuntimeState } from '@/engine/types';

const baseCombat: CombatState = {
  round: 1,
  turnOrder: [
    { actorId: 'pc1', initiative: 18 },
    { actorId: 'm1',  initiative: 14 },
    { actorId: 'm2',  initiative: 10 },
  ],
  currentIdx: 0,
};

describe('endTurn', () => {
  it('advances currentIdx', () => {
    const r = endTurn({ combat: baseCombat });
    expect(r.mutations.find((m) => m.op === 'advance_turn')).toBeDefined();
    expect(r.data?.nextActorId).toBe('m1');
    expect(r.data?.newRound).toBe(false);
  });

  it('wraps and increments round when at last actor', () => {
    const last: CombatState = { ...baseCombat, currentIdx: 2 };
    const r = endTurn({ combat: last });
    expect(r.data?.nextActorId).toBe('pc1');
    expect(r.data?.newRound).toBe(true);
    expect(r.data?.round).toBe(2);
  });
});

describe('tickConditions', () => {
  it('decrements duration of round-counted conditions for current actor', () => {
    const runtime: ActorRuntimeState = {
      actorId: 'pc1', hpCurrent: 10, tempHp: 0, deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'poisoned', source: 'goblin bite', durationRounds: 2, appliedRound: 1 },
        { slug: 'frightened', source: 'fear', durationRounds: 'until_removed', appliedRound: 1 },
      ],
    };
    const r = tickConditions({ runtime, currentRound: 2 });
    const stillThere = r.data?.conditions ?? [];
    expect(stillThere.find((c) => c.slug === 'poisoned')?.durationRounds).toBe(1);
    expect(stillThere.find((c) => c.slug === 'frightened')?.durationRounds).toBe('until_removed');
  });

  it('removes conditions whose duration reaches 0', () => {
    const runtime: ActorRuntimeState = {
      actorId: 'pc1', hpCurrent: 10, tempHp: 0, deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'poisoned', source: 'goblin bite', durationRounds: 1, appliedRound: 1 },
      ],
    };
    const r = tickConditions({ runtime, currentRound: 2 });
    expect(r.data?.conditions.length).toBe(0);
    expect(r.mutations.some((m) => m.op === 'remove_condition')).toBe(true);
  });
});
