/**
 * Plan D — compute the runtime's master-prompt content hash for
 * comparison against the baked variant's stamped hash. Memoised because
 * the input is effectively static per-process (the 5 prompt constants
 * are bundled, the handbook/world-lore files are read-once-cached, the
 * SRD context comes from DB but rarely changes mid-process).
 *
 * If the user updates handbook.md / world_lore.md / the prompt
 * constants and restarts the server, the next call recomputes from
 * scratch because the cached handbook string is also reset. The
 * staleness warning then fires on the next baked-model turn.
 */

import {
  MASTER_PROMPT_VERSION,
  MASTER_SYSTEM_PROMPT_BASE,
  MASTER_TOOL_CONTRACT,
  MASTER_META_TOOLS_INSTRUCTION,
  MASTER_ROLL_TRIGGERS,
  MASTER_REWARDS_MANDATE,
  MASTER_MEMORY_TOOL_RULE,
} from './system-prompt';
import { getMasterHandbook, getMasterWorldLore } from './handbook';
import { buildSrdContext } from './srd-context';
import { computeMasterPromptHash } from './baked-models';

let _cached: Promise<string> | null = null;

/**
 * Returns the current runtime's master-prompt hash. First call awaits
 * the SRD context build (DB hit); subsequent calls return the cached
 * promise.
 *
 * NOTE: this must match the build script's `computeContentHash` exactly.
 * Both call `computeMasterPromptHash(systemContent, MASTER_PROMPT_VERSION)`
 * with the same concatenation order, so a drift can only happen if one
 * side reorders blocks. Keep them in sync.
 */
export function getRuntimePromptHash(): Promise<string> {
  if (_cached) return _cached;
  _cached = (async () => {
    const handbook = getMasterHandbook(); // FULL, matches build script
    const worldLore = getMasterWorldLore(); // FULL
    const srdContext = await buildSrdContext(); // FULL
    const systemContent = [
      MASTER_SYSTEM_PROMPT_BASE,
      MASTER_TOOL_CONTRACT,
      MASTER_META_TOOLS_INSTRUCTION,
      MASTER_ROLL_TRIGGERS,
      MASTER_REWARDS_MANDATE,
      handbook,
      worldLore,
      MASTER_MEMORY_TOOL_RULE,
      srdContext,
    ].join('\n\n');
    return computeMasterPromptHash(systemContent, MASTER_PROMPT_VERSION);
  })();
  return _cached;
}

/** Test seam — clear the cached hash between tests. */
export function _clearRuntimePromptHashCache(): void {
  _cached = null;
}
