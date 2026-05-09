import type { TurnState } from '../types';

export function newTurnState(): TurnState {
  return {
    actionUsed: false,
    bonusUsed: false,
    reactionUsed: false,
    movementSpentFt: 0,
    freeInteractionsUsed: 0,
    dodging: false,
    disengaged: false,
    dashed: false,
  };
}

export function canConsumeAction(
  state: TurnState,
  kind: 'action' | 'bonus' | 'reaction',
): boolean {
  switch (kind) {
    case 'action':
      return !state.actionUsed;
    case 'bonus':
      return !state.bonusUsed;
    case 'reaction':
      return !state.reactionUsed;
  }
}

export function consumeAction(
  state: TurnState,
  kind: 'action' | 'bonus' | 'reaction',
): TurnState {
  if (!canConsumeAction(state, kind)) return state;
  const map = { action: 'actionUsed', bonus: 'bonusUsed', reaction: 'reactionUsed' } as const;
  return { ...state, [map[kind]]: true };
}

export function canMoveFurther(
  state: TurnState,
  baseSpeedFt: number,
  additionalFt: number,
): boolean {
  const budget = state.dashed ? baseSpeedFt * 2 : baseSpeedFt;
  return state.movementSpentFt + additionalFt <= budget;
}

export function spendMovement(state: TurnState, feet: number): TurnState {
  return { ...state, movementSpentFt: state.movementSpentFt + feet };
}

export function resetForNewTurn(_state: TurnState): TurnState {
  // A new turn = fresh state. Readied actions persist OUTSIDE the turn (they fire on trigger),
  // so they're cleared on actor's new turn (this function is called when the actor becomes active again).
  return newTurnState();
}
