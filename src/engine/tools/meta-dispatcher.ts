import {
  isMetaName,
  resolveSubactionToToolName,
  type MetaName,
} from './meta-tools';

/**
 * Rewrites a tool call coming from the LLM.
 *
 * - If `name` is one of the 8 meta-tools (combat_action, spell_action, …),
 *   reads `input.subaction`, validates it belongs to that meta, looks up
 *   the underlying ALWAYS_ON tool name, and returns
 *   `{ resolvedName, resolvedInput }` where `resolvedInput` is the original
 *   input minus the `subaction` discriminator key.
 *
 * - If `name` is a plain ALWAYS_ON tool name (cloud path), returns the
 *   input unchanged.
 *
 * Throws on:
 *   - meta name with no `input.subaction` field
 *   - meta name with `input.subaction` that doesn't belong to that meta
 *
 * The downstream game-engine handler validates the *payload* schema —
 * the dispatcher only concerns itself with the meta → underlying-name mapping.
 */
export interface DispatchedCall {
  resolvedName: string;
  resolvedInput: Record<string, unknown>;
}

export function dispatchMetaCall(
  name: string,
  input: Record<string, unknown>,
): DispatchedCall {
  if (!isMetaName(name)) {
    return { resolvedName: name, resolvedInput: input };
  }
  const meta = name as MetaName;
  const sub = input.subaction;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error(`meta-dispatcher: ${meta} requires a 'subaction' string in input`);
  }
  const resolved = resolveSubactionToToolName(meta, sub);
  if (!resolved) {
    throw new Error(`meta-dispatcher: '${sub}' is not a valid sub-action for ${meta}`);
  }
  // Strip the discriminator from the input — the underlying tool handler
  // doesn't know about `subaction` and would either error or ignore it.
  const { subaction: _subaction, ...rest } = input;
  void _subaction;
  return { resolvedName: resolved, resolvedInput: rest };
}
