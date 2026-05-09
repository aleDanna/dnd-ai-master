import { describe, expect, it } from 'vitest';
import { resolveStandardAction } from '@/engine/combat/standard-actions';
import { newTurnState } from '@/engine/combat/turn-state';
import type { ActorRuntimeState } from '@/engine/types';

const baseRt: ActorRuntimeState = {
  actorId: 'pc1',
  hpCurrent: 10,
  tempHp: 0,
  conditions: [],
  deathSaves: { successes: 0, failures: 0 },
};

describe('resolveStandardAction — dash', () => {
  it('emits consume_action(action) + take_dash', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'dash' }, baseRt);
    expect(r.ok).toBe(true);
    const ops = r.mutations.map((m) => m.op);
    expect(ops).toEqual(['consume_action', 'take_dash']);
  });
  it('errors if action already used', () => {
    const rt: ActorRuntimeState = { ...baseRt, turnState: { ...newTurnState(), actionUsed: true } };
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'dash' }, rt);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/action_already_used/);
  });
  it('useBonusAction:true uses bonus budget (Rogue Cunning Action)', () => {
    const rt: ActorRuntimeState = { ...baseRt, turnState: { ...newTurnState(), actionUsed: true } };
    const r = resolveStandardAction(
      { actorId: 'pc1', kind: 'dash', useBonusAction: true },
      rt,
    );
    expect(r.ok).toBe(true);
    const consumeMut = r.mutations.find((m) => m.op === 'consume_action');
    expect(consumeMut).toMatchObject({ kind: 'bonus' });
  });
  it('errors if bonus already used and useBonusAction=true', () => {
    const rt: ActorRuntimeState = { ...baseRt, turnState: { ...newTurnState(), bonusUsed: true } };
    const r = resolveStandardAction(
      { actorId: 'pc1', kind: 'dash', useBonusAction: true },
      rt,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bonus_already_used/);
  });
});

describe('resolveStandardAction — disengage', () => {
  it('emits consume_action + take_disengage', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'disengage' }, baseRt);
    expect(r.ok).toBe(true);
    expect(r.mutations.map((m) => m.op)).toEqual(['consume_action', 'take_disengage']);
  });
});

describe('resolveStandardAction — dodge', () => {
  it('emits consume_action + take_dodge', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'dodge' }, baseRt);
    expect(r.ok).toBe(true);
    expect(r.mutations.map((m) => m.op)).toEqual(['consume_action', 'take_dodge']);
  });
});

describe('resolveStandardAction — help', () => {
  it('emits consume_action + add_condition(helped) on beneficiary', () => {
    const r = resolveStandardAction(
      { actorId: 'pc1', kind: 'help', beneficiaryId: 'pc2', currentRound: 5 },
      baseRt,
    );
    expect(r.ok).toBe(true);
    const addCond = r.mutations.find((m) => m.op === 'add_condition');
    expect(addCond).toBeDefined();
    if (addCond?.op === 'add_condition') {
      expect(addCond.actorId).toBe('pc2');
      expect(addCond.condition.slug).toBe('helped');
      expect(addCond.condition.appliedRound).toBe(5);
      expect(addCond.condition.durationRounds).toBe(1);
    }
  });
  it('errors without beneficiaryId', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'help' }, baseRt);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/help_requires_beneficiary/);
  });
});

describe('resolveStandardAction — hide', () => {
  it('returns rollNeeded for Stealth', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'hide', dc: 15 }, baseRt);
    expect(r.ok).toBe(true);
    expect(r.rollNeeded).toEqual({ ability: 'DEX', skill: 'Stealth', dc: 15 });
  });
  it('default dc=10 if not provided', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'hide' }, baseRt);
    expect(r.rollNeeded?.dc).toBe(10);
  });
  it('still consumes the action', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'hide' }, baseRt);
    expect(r.mutations.map((m) => m.op)).toEqual(['consume_action']);
  });
});

describe('resolveStandardAction — search', () => {
  it('returns rollNeeded for Perception', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'search', dc: 12 }, baseRt);
    expect(r.rollNeeded).toEqual({ ability: 'WIS', skill: 'Perception', dc: 12 });
  });
});

describe('resolveStandardAction — ready', () => {
  it('emits set_readied with trigger + action', () => {
    const r = resolveStandardAction(
      {
        actorId: 'pc1',
        kind: 'ready',
        trigger: 'enemy approaches',
        readyAction: 'Attack with bow',
      },
      baseRt,
    );
    expect(r.ok).toBe(true);
    const setReadied = r.mutations.find((m) => m.op === 'set_readied');
    expect(setReadied).toBeDefined();
    if (setReadied?.op === 'set_readied') {
      expect(setReadied.trigger).toBe('enemy approaches');
      expect(setReadied.action).toBe('Attack with bow');
    }
  });
  it('errors without trigger or readyAction', () => {
    const r1 = resolveStandardAction(
      { actorId: 'pc1', kind: 'ready', trigger: 'enemy' },
      baseRt,
    );
    expect(r1.ok).toBe(false);
    const r2 = resolveStandardAction(
      { actorId: 'pc1', kind: 'ready', readyAction: 'Attack' },
      baseRt,
    );
    expect(r2.ok).toBe(false);
  });
});

describe('resolveStandardAction — use_object', () => {
  it('emits only consume_action', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'use_object' }, baseRt);
    expect(r.ok).toBe(true);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]?.op).toBe('consume_action');
  });
});

describe('resolveStandardAction — runtime undefined fallback', () => {
  it('treats missing runtime as fresh turn state', () => {
    const r = resolveStandardAction({ actorId: 'pc1', kind: 'dodge' }, undefined);
    expect(r.ok).toBe(true);
    expect(r.mutations.map((m) => m.op)).toEqual(['consume_action', 'take_dodge']);
  });
});
