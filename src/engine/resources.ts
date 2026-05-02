import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';

export interface UseResourceInput {
  char: Character;
  runtime: ActorRuntimeState;
  featureSlug: string;
  amount: number;
}

export function useResource(input: UseResourceInput): ActionResult<{ remaining: number | 'unlimited' }> {
  const feature = input.char.features.find((f) => f.slug === input.featureSlug);
  if (!feature) return { ok: false, error: 'unknown_feature', rolls: [], mutations: [] };

  if (feature.usesMax === 'unlimited') {
    const mutations: Mutation[] = [{ op: 'use_resource', actorId: input.runtime.actorId, featureSlug: input.featureSlug, amount: input.amount }];
    return { ok: true, data: { remaining: 'unlimited' }, rolls: [], mutations };
  }

  const used = input.runtime.resourcesUsed?.[input.featureSlug] ?? 0;
  const remaining = feature.usesMax - used;
  if (remaining < input.amount) {
    return { ok: false, error: 'no_uses', rolls: [], mutations: [] };
  }
  const mutations: Mutation[] = [{ op: 'use_resource', actorId: input.runtime.actorId, featureSlug: input.featureSlug, amount: input.amount }];
  return {
    ok: true,
    data: { remaining: remaining - input.amount },
    rolls: [],
    mutations,
  };
}
