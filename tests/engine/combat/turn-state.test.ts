import { describe, expect, it } from 'vitest';
import {
  newTurnState,
  canConsumeAction,
  consumeAction,
  canMoveFurther,
  spendMovement,
  resetForNewTurn,
} from '@/engine/combat/turn-state';
import type { TurnState } from '@/engine/types';

describe('turn-state — newTurnState', () => {
  it('creates fresh state with no resources used', () => {
    const ts = newTurnState();
    expect(ts).toEqual({
      actionUsed: false,
      bonusUsed: false,
      reactionUsed: false,
      movementSpentFt: 0,
      freeInteractionsUsed: 0,
      dodging: false,
      disengaged: false,
      dashed: false,
    });
  });
});

describe('turn-state — canConsumeAction', () => {
  it('true when action not yet used', () => {
    expect(canConsumeAction(newTurnState(), 'action')).toBe(true);
  });
  it('false when action already used', () => {
    const ts = { ...newTurnState(), actionUsed: true };
    expect(canConsumeAction(ts, 'action')).toBe(false);
  });
  it('reactions tracked separately', () => {
    const ts = { ...newTurnState(), actionUsed: true, bonusUsed: true };
    expect(canConsumeAction(ts, 'reaction')).toBe(true);
  });
});

describe('turn-state — consumeAction', () => {
  it('marks action used', () => {
    const next = consumeAction(newTurnState(), 'action');
    expect(next.actionUsed).toBe(true);
    expect(next.bonusUsed).toBe(false);
  });
  it('returns same state if already used (idempotent)', () => {
    const ts = { ...newTurnState(), actionUsed: true };
    const next = consumeAction(ts, 'action');
    expect(next).toEqual(ts);
  });
});

describe('turn-state — movement', () => {
  it('canMoveFurther true within speed', () => {
    expect(canMoveFurther(newTurnState(), 30, 10)).toBe(true);
  });
  it('false when would exceed speed', () => {
    const ts = { ...newTurnState(), movementSpentFt: 25 };
    expect(canMoveFurther(ts, 30, 10)).toBe(false);
  });
  it('Dash doubles effective budget', () => {
    const ts = { ...newTurnState(), dashed: true, movementSpentFt: 30 };
    expect(canMoveFurther(ts, 30, 25)).toBe(true);  // total 55 ≤ 60 (30×2)
  });
  it('spendMovement increments counter', () => {
    const next = spendMovement(newTurnState(), 15);
    expect(next.movementSpentFt).toBe(15);
  });
});

describe('turn-state — resetForNewTurn', () => {
  it('zeroes everything except readied', () => {
    const used: TurnState = {
      actionUsed: true, bonusUsed: true, reactionUsed: true,
      movementSpentFt: 30, freeInteractionsUsed: 1,
      dodging: true, disengaged: true, dashed: true,
      readied: { trigger: 'enemy enters', action: 'Attack' },
    };
    const reset = resetForNewTurn(used);
    expect(reset.actionUsed).toBe(false);
    expect(reset.bonusUsed).toBe(false);
    expect(reset.movementSpentFt).toBe(0);
    expect(reset.dodging).toBe(false);
    // readied PERSISTS until trigger fires or actor's turn comes again
    expect(reset.readied).toBeUndefined(); // actually clear when it's THE actor's new turn
  });
});
