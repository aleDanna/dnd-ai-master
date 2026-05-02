import type { ActionResult, ActorRuntimeState, CombatState, ConditionInstance, Mutation } from '../types';

export interface EndTurnInput {
  combat: CombatState;
}

export function endTurn(input: EndTurnInput): ActionResult<{ nextActorId: string; newRound: boolean; round: number }> {
  const { turnOrder, currentIdx, round } = input.combat;
  const isLast = currentIdx >= turnOrder.length - 1;
  const nextIdx = isLast ? 0 : currentIdx + 1;
  const nextRound = isLast ? round + 1 : round;
  const nextActorId = turnOrder[nextIdx]!.actorId;

  return {
    ok: true,
    data: { nextActorId, newRound: isLast, round: nextRound },
    rolls: [],
    mutations: [{ op: 'advance_turn' }],
  };
}

export interface TickConditionsInput {
  runtime: ActorRuntimeState;
  currentRound: number;
}

export function tickConditions(input: TickConditionsInput): ActionResult<{ conditions: ConditionInstance[] }> {
  const remaining: ConditionInstance[] = [];
  const mutations: Mutation[] = [];
  for (const c of input.runtime.conditions) {
    if (c.durationRounds === 'until_removed') {
      remaining.push(c);
      continue;
    }
    const newDuration = c.durationRounds - 1;
    if (newDuration <= 0) {
      mutations.push({ op: 'remove_condition', actorId: input.runtime.actorId, conditionSlug: c.slug });
    } else {
      remaining.push({ ...c, durationRounds: newDuration });
    }
  }
  return { ok: true, data: { conditions: remaining }, rolls: [], mutations };
}
