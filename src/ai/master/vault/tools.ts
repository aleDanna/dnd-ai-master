import type { ToolDef } from '@/ai/provider/types';
import { listVaultDir, readVaultFile } from './path';

/**
 * REQ-010 — Fixed 4-tool surface (3 of 4 in Phase 01; `apply_event` arrives in Phase 02).
 * REQ-011 — NEVER expose singular `read_vault(path)`. Only batched `read_vault_multi`.
 * REQ-013 — Server accepts both turn terminators (`end_turn` tool call AND
 *           `no_tool_calls + content`). This module defines the `end_turn` tool;
 *           the dual-terminator handling is in the loop module (plan 04).
 *
 * Tool definitions are in the canonical Anthropic-shaped form (`ToolDef =
 * Anthropic.Messages.Tool`). The local provider's `anthropicToolToOllama`
 * already translates this to Ollama's `{type:'function', function:{...}}`
 * envelope — reusing the existing shape means the vault path inherits the
 * provider plumbing for free.
 */
export const VAULT_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'read_vault_multi',
    // The "Read MANY ... in ONE call" wording is load-bearing per spike 009.
    // DO NOT paraphrase — paraphrasing regresses to one-call-per-path emission
    // that loses the entire wall-clock advantage of batching.
    description: 'Read MANY markdown files in ONE call. Pass an array of paths. Prefer this over multiple read_vault calls.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of vault paths to read',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'list_vault',
    description: 'List immediate children of a vault directory.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Vault directory path' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'end_turn',
    description: 'Conclude the turn with a final narrative response.',
    input_schema: {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'The final narrative response to the player.' },
      },
      required: ['response'],
    },
  },
  // apply_event is Phase 02 — intentionally omitted in Phase 01 (vault is read-only for game state).
];

export const VAULT_TOOL_COUNT = VAULT_TOOL_DEFINITIONS.length;

/** Maximum number of paths accepted by a single `read_vault_multi` call. */
const READ_VAULT_MULTI_MAX_PATHS = 16;

/**
 * REQ-014 — Format multiple-read results as concatenated blocks.
 *
 * Preserves the model's requested order (no sorting). Spike 009 format:
 * `### {path}` heading per file, content body, blocks separated by `---`.
 */
export function formatMultiReadResult(entries: { path: string; content: string }[]): string {
  return entries.map(({ path, content }) => `### ${path}\n\n${content}`).join('\n\n---\n\n');
}

export interface VaultDispatchContext {
  vaultRoot?: string;
}

export interface VaultDispatchResult {
  content: string;
  isError: boolean;
  /** Only set for `end_turn` — the final narrative the loop should commit. */
  endTurnResponse?: string;
}

/**
 * Map a vault tool call to its filesystem effect (or, for `end_turn`,
 * the terminator value). Never throws — all errors surface as marker
 * strings in `content` so the model can self-correct on the next turn.
 */
export async function dispatchVaultTool(
  name: string,
  input: unknown,
  ctx?: VaultDispatchContext,
): Promise<VaultDispatchResult> {
  const vaultRoot = ctx?.vaultRoot;

  if (name === 'read_vault_multi') {
    const raw = (input ?? {}) as { paths?: unknown };
    if (!Array.isArray(raw.paths) || raw.paths.length === 0) {
      return { content: 'ERROR: read_vault_multi requires a non-empty paths array', isError: true };
    }
    if (raw.paths.length > READ_VAULT_MULTI_MAX_PATHS) {
      return {
        content: `ERROR: read_vault_multi accepts at most ${READ_VAULT_MULTI_MAX_PATHS} paths per call (got ${raw.paths.length})`,
        isError: true,
      };
    }
    const entries: { path: string; content: string }[] = [];
    for (const p of raw.paths) {
      const pathStr = typeof p === 'string' ? p : String(p);
      // readVaultFile already returns inline error markers on bad paths /
      // missing files — per-file errors don't fail the batch (spike 009).
      const content = await readVaultFile(pathStr, vaultRoot);
      entries.push({ path: pathStr, content });
    }
    return { content: formatMultiReadResult(entries), isError: false };
  }

  if (name === 'list_vault') {
    const raw = (input ?? {}) as { directory?: unknown };
    if (typeof raw.directory !== 'string') {
      return { content: 'ERROR: list_vault requires a string `directory` argument', isError: true };
    }
    const children = await listVaultDir(raw.directory, vaultRoot);
    if (children.length === 0) {
      return { content: '(no children or path not found)', isError: false };
    }
    const body = `Children of ${raw.directory}:\n` + children.map((c) => `- ${c}`).join('\n');
    return { content: body, isError: false };
  }

  if (name === 'end_turn') {
    const raw = (input ?? {}) as { response?: unknown };
    const response = typeof raw.response === 'string' ? raw.response : '';
    return { content: '', isError: false, endTurnResponse: response };
  }

  return { content: 'ERROR: unknown vault tool: ' + name, isError: true };
}
