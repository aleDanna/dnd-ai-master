/**
 * Plan D + E.1 — compute the runtime's master-prompt content hash for
 * comparison against the baked variant's stamped hash. Memoised because
 * the input is effectively static per-process (the slim prompt constants
 * are bundled, the SRD context comes from DB but rarely changes
 * mid-process).
 *
 * If the user updates the prompt constants and restarts the server, the
 * next call recomputes from scratch. The staleness warning then fires on
 * the next baked-model turn.
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
import { computeMasterPromptHash } from './baked-models';

let _cached: Promise<string> | null = null;

/**
 * Returns the current runtime's master-prompt hash. First call awaits
 * the SRD context build (DB hit); subsequent calls return the cached
 * promise.
 *
 * NOTE: this must match the build script's `computeContentHash` exactly.
 * Both call `computeMasterPromptHash(systemContent, MASTER_PROMPT_VERSION)`
 * with the same concatenation order (7-block slim manifest, Plan E.1),
 * so a drift can only happen if one side reorders blocks. Keep them in sync.
 */
export function getRuntimePromptHash(): Promise<string> {
  if (_cached) return _cached;
  _cached = (async () => {
    const srdContext = await buildSrdContext({ compact: true });
    const systemContent = [
      MASTER_SYSTEM_PROMPT_BASE_SLIM,
      MASTER_TOOL_CONTRACT_SLIM,
      MASTER_META_TOOLS_INSTRUCTION,
      MASTER_REWARDS_MANDATE_SLIM,
      MASTER_MEMORY_TOOL_RULE_SLIM,
      MASTER_HANDBOOK_ULTRA_SLIM,
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
