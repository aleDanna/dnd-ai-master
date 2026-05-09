import type { ConcentrationState, Mutation } from '../types';

export function concentrationCheckDC(damage: number): number {
  return Math.max(10, Math.floor(damage / 2));
}

export interface StartConcentrationInput {
  actorId: string;
  spellSlug: string;
  slotLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  startedRound: number;
  currentlyConcentratingOn?: ConcentrationState;
}

export function startConcentrationMutations(input: StartConcentrationInput): Mutation[] {
  const muts: Mutation[] = [];
  if (input.currentlyConcentratingOn) {
    muts.push({
      op: 'break_concentration',
      actorId: input.actorId,
      reason: 'new_concentration',
    });
  }
  muts.push({
    op: 'set_concentration',
    actorId: input.actorId,
    spellSlug: input.spellSlug,
    slotLevel: input.slotLevel,
    startedRound: input.startedRound,
  });
  return muts;
}

export interface BreakConcentrationInput {
  actorId: string;
  reason: 'damage' | 'incapacitated' | 'killed' | 'new_concentration' | 'manual';
}

export function breakConcentrationMutations(input: BreakConcentrationInput): Mutation[] {
  return [{ op: 'break_concentration', actorId: input.actorId, reason: input.reason }];
}
