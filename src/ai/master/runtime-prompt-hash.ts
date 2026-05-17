/**
 * Plan D + E.1 + E.2 selective — compute the runtime's master-prompt content
 * hash for comparison against the baked variant's stamped hash. The hash
 * varies by model class:
 *   - large bases (>=7B): LEAN manifest (no MASTER_HANDBOOK_ULTRA_SLIM)
 *   - small bases (3-4B): full slim manifest with the always-on handbook block
 *
 * Memoised per (isLarge), so 2 entries max per process.
 */

import {
  MASTER_PROMPT_VERSION,
  MASTER_META_TOOLS_INSTRUCTION,
} from './system-prompt';
import {
  MASTER_SYSTEM_PROMPT_BASE_SLIM,
  MASTER_TOOL_CONTRACT_SLIM,
  MASTER_REWARDS_MANDATE_SLIM,
  MASTER_MEMORY_TOOL_RULE_SLIM,
  MASTER_HANDBOOK_ULTRA_SLIM,
} from './slim-prompts';
import { buildSrdContext } from './srd-context';
import { computeMasterPromptHash, getBakedBaseModel, isLargeModelBase } from './baked-models';

const _cached: Map<boolean, Promise<string>> = new Map();

/**
 * Returns the current runtime's master-prompt hash for the given baked
 * variant. Derives the base slug → large/small classification → manifest
 * variant. Must match the build script's per-base content exactly; both
 * sides go through `isLargeModelBase()` on the same base slug.
 *
 * If `bakedName` is omitted (legacy callers / non-baked turns) defaults
 * to the small/guard-rail manifest — that's the safer assumption.
 */
export function getRuntimePromptHash(bakedName?: string): Promise<string> {
  const baseSlug = bakedName ? getBakedBaseModel(bakedName) : null;
  const isLarge = baseSlug ? isLargeModelBase(baseSlug) : false;
  const existing = _cached.get(isLarge);
  if (existing) return existing;

  const promise = (async () => {
    const srdContext = await buildSrdContext({ compact: true });
    const blocks: string[] = [
      MASTER_SYSTEM_PROMPT_BASE_SLIM,
      MASTER_TOOL_CONTRACT_SLIM,
      MASTER_META_TOOLS_INSTRUCTION,
      MASTER_REWARDS_MANDATE_SLIM,
      MASTER_MEMORY_TOOL_RULE_SLIM,
      ...(isLarge ? [] : [MASTER_HANDBOOK_ULTRA_SLIM]),
      srdContext,
    ];
    return computeMasterPromptHash(blocks.join('\n\n'), MASTER_PROMPT_VERSION);
  })();
  _cached.set(isLarge, promise);
  return promise;
}

/** Test seam — clear the cached hashes between tests. */
export function _clearRuntimePromptHashCache(): void {
  _cached.clear();
}
