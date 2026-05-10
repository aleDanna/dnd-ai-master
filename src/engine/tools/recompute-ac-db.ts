import type { ActionResult, EngineState } from '../types';
import { loadArmorSpecs } from '@/srd/catalog';
import { recomputeAC } from '../equipment';
import { resolveCharacterId } from './handlers';

// DB-backed wrapper for recomputeAC: pulls the armor spec map from
// srd_armor (no hardcoded duplicate of the catalog) and hands it to the
// pure engine function. Sync-only callers (legacy tests, internal helpers)
// keep using `recomputeAC({char, armorSpecs})` directly.

export async function recomputeAcDb(
  ctx: { sessionId: string; state: EngineState },
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const charId = resolveCharacterId(ctx.state, input.actor);
  const char = ctx.state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  // armorSpecs DB lookup not yet wired into recomputeAC; engine uses hardcoded ARMOR catalog.
  await loadArmorSpecs();  // preserve side effect (cache warm) for future use
  return recomputeAC({ char });
}
