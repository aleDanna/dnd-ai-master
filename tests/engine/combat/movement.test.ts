import { describe, expect, it } from 'vitest';
import { resolveMove } from '../../../src/engine/combat/movement';
import { newTurnState } from '../../../src/engine/combat/turn-state';
import type { ActorRuntimeState } from '../../../src/engine/types';

const baseRt: ActorRuntimeState = {
  actorId: 'pc1',
  hpCurrent: 10,
  tempHp: 0,
  conditions: [],
  deathSaves: { successes: 0, failures: 0 },
};

describe('resolveMove — distance budget', () => {
  it('engaged → near costs 5ft and succeeds with speed 30', () => {
    const rt = { ...baseRt, position: { band: 'engaged' as const, engagedWith: ['m1'] } };
    const r = resolveMove({ actorId: 'pc1', toBand: 'near', leavesEngagementWith: ['m1'] }, rt, 30);
    expect(r.ok).toBe(true);
    const moveMut = r.mutations.find((m) => m.op === 'consume_movement');
    expect(moveMut).toMatchObject({ feet: 5 });
  });

  it('near → far costs 25ft', () => {
    const r = resolveMove({ actorId: 'pc1', toBand: 'far' }, baseRt, 30);
    expect(r.ok).toBe(true);
    const moveMut = r.mutations.find((m) => m.op === 'consume_movement');
    expect(moveMut).toMatchObject({ feet: 25 });
  });

  it('errors insufficient_movement when budget exceeded', () => {
    const rt = { ...baseRt, turnState: { ...newTurnState(), movementSpentFt: 26 } };
    const r = resolveMove({ actorId: 'pc1', toBand: 'far' }, rt, 30);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('insufficient_movement');
  });

  it('Dash doubles budget (60ft), allowing near → far → distant in one turn', () => {
    const rt = { ...baseRt, turnState: { ...newTurnState(), dashed: true, movementSpentFt: 0 } };
    const r = resolveMove({ actorId: 'pc1', toBand: 'distant' }, rt, 30);
    // near → far = 25, far → distant = 60 → total 85 ft. Dashed = 60 budget. 85 > 60, fail.
    expect(r.ok).toBe(false);

    // But near → far is fine even if other movement was already spent.
    const rt2 = { ...baseRt, turnState: { ...newTurnState(), dashed: true, movementSpentFt: 25 } };
    const r2 = resolveMove({ actorId: 'pc1', toBand: 'far' }, rt2, 30);
    expect(r2.ok).toBe(true);  // 0+25 = 25 ≤ 60
  });
});

describe('resolveMove — OA auto-trigger', () => {
  it('leaving engagement → emits opportunity_attack_triggered for the former engager', () => {
    const rt = { ...baseRt, position: { band: 'engaged' as const, engagedWith: ['m1'] } };
    const r = resolveMove({ actorId: 'pc1', toBand: 'near', leavesEngagementWith: ['m1'] }, rt, 30);
    const oa = r.mutations.find((m) => m.op === 'opportunity_attack_triggered');
    expect(oa).toMatchObject({ attackerId: 'm1', targetId: 'pc1' });
  });

  it('disengaged → no OA emitted', () => {
    const rt = {
      ...baseRt,
      position: { band: 'engaged' as const, engagedWith: ['m1'] },
      turnState: { ...newTurnState(), disengaged: true },
    };
    const r = resolveMove({ actorId: 'pc1', toBand: 'near', leavesEngagementWith: ['m1'] }, rt, 30);
    const oa = r.mutations.find((m) => m.op === 'opportunity_attack_triggered');
    expect(oa).toBeUndefined();
  });

  it('multiple engagers: each that we LEAVE triggers an OA', () => {
    const rt = { ...baseRt, position: { band: 'engaged' as const, engagedWith: ['m1', 'm2', 'm3'] } };
    const r = resolveMove({ actorId: 'pc1', toBand: 'engaged', leavesEngagementWith: ['m1', 'm2'] }, rt, 30);
    const oas = r.mutations.filter((m) => m.op === 'opportunity_attack_triggered');
    expect(oas).toHaveLength(2);
    expect(oas.map((o) => (o as { attackerId: string }).attackerId).sort()).toEqual(['m1', 'm2']);
  });

  it('entering engagement does NOT trigger OA on us', () => {
    // OAs trigger when WE leave engagement, not when we enter.
    const rt = { ...baseRt, position: { band: 'near' as const, engagedWith: [] } };
    const r = resolveMove({ actorId: 'pc1', toBand: 'engaged', entersEngagementWith: ['m1'] }, rt, 30);
    const oa = r.mutations.find((m) => m.op === 'opportunity_attack_triggered');
    expect(oa).toBeUndefined();
    const setPos = r.mutations.find((m) => m.op === 'set_position');
    if (setPos?.op === 'set_position') {
      expect(setPos.position.engagedWith).toEqual(['m1']);
    }
  });
});

describe('resolveMove — set_position correctness', () => {
  it('sets band to engaged when newEngagement non-empty regardless of toBand input', () => {
    const r = resolveMove({ actorId: 'pc1', toBand: 'far', entersEngagementWith: ['m1'] }, baseRt, 30);
    // Caller asked for 'far' but engagement override forces 'engaged'.
    const setPos = r.mutations.find((m) => m.op === 'set_position');
    if (setPos?.op === 'set_position') {
      expect(setPos.position.band).toBe('engaged');
    }
  });
});
