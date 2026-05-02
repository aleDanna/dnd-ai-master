import type { ActionResult, ActorRuntimeState, CombatActor, ConditionInstance, ConditionSlug, Mutation } from './types';

export interface ApplyConditionInput {
  target: CombatActor;
  runtime: ActorRuntimeState;
  condition: ConditionInstance;
}

export function applyCondition(input: ApplyConditionInput): ActionResult<{ replaced: boolean }> {
  if (input.target.conditionImmunities.includes(input.condition.slug)) {
    return { ok: false, error: 'immune', rolls: [], mutations: [] };
  }
  const exists = input.runtime.conditions.some((c) => c.slug === input.condition.slug);
  const mutations: Mutation[] = [
    { op: 'add_condition', actorId: input.runtime.actorId, condition: input.condition },
  ];
  return {
    ok: true,
    data: { replaced: exists },
    rolls: [],
    mutations,
  };
}

export interface RemoveConditionInput {
  runtime: ActorRuntimeState;
  conditionSlug: ConditionSlug;
}

export function removeCondition(input: RemoveConditionInput): ActionResult<{ removed: boolean }> {
  const exists = input.runtime.conditions.some((c) => c.slug === input.conditionSlug);
  if (!exists) {
    return { ok: true, data: { removed: false }, rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { removed: true },
    rolls: [],
    mutations: [{ op: 'remove_condition', actorId: input.runtime.actorId, conditionSlug: input.conditionSlug }],
  };
}
