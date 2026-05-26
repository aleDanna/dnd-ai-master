import { randomUUID } from 'node:crypto';
import type { ToolDef } from '@/ai/provider/types';
import { listVaultDir, readVaultFile, VAULT_CAMPAIGNS_ROOT } from './path';
import { validateEvent, EVENT_SCHEMA_VERSION, type VaultEventEnvelope } from './events-schema';
import { EventsWriter } from './events-writer';
import { regenerateAffectedViews } from './projector';
import { eventsPath, UUID_REGEX } from './campaign-paths';

/**
 * REQ-010 — Fixed 4-tool surface. Phase 02 closed the 4th tool — REQ-010 fully
 *           satisfied (Phase 01 shipped 3; Phase 02 added `apply_event`).
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
  {
    name: 'apply_event',
    description:
      'Append a game-state mutation event (HP change, condition add, slot use, inventory change, etc.). Returns the new event_id on success. One event per call; do not batch.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Event type. One of: hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove.',
        },
        payload: {
          type: 'object',
          description:
            'Event-specific data. The `character` field is the character UUID (the value of `id` in the materialized view frontmatter — NOT the character name; names are not unique across campaigns). For hp_change: {character: <uuid>, delta: number}. For condition_add/remove: {character: <uuid>, condition: string}. For spell_slot_use/restore: {character: <uuid>, level: number (1-9)}. For inventory_add/remove: {character: <uuid>, item: string, qty: positive integer < 1000}.',
        },
      },
      required: ['type', 'payload'],
    },
  },
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
  /**
   * Campaign UUID — required for `apply_event` (the dispatch branch resolves
   * paths under `VAULT_CAMPAIGNS_ROOT/<campaignId>/`). Phase 01 read-only
   * tools (read_vault_multi, list_vault, end_turn) ignore this field, except
   * for the Phase 02 Decision 4 extension: read_vault_multi and list_vault
   * inspect path prefixes and route `/campaigns/...` reads to
   * VAULT_CAMPAIGNS_ROOT transparently (no campaignId needed for read).
   *
   * Phase 02 — locked by REQ-007 (per-campaign storage outside repo) and
   * T-02-01/T-02-07 mitigations (server-side-only campaignId; LLM cannot
   * supply this).
   */
  campaignId?: string;
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
      // Decision 4 — root routing. Paths starting with `/campaigns/` are
      // resolved under VAULT_CAMPAIGNS_ROOT (with the `/campaigns/` prefix
      // stripped, because VAULT_CAMPAIGNS_ROOT IS the campaigns root); all
      // other paths stay under VAULT_ROOT (or ctx.vaultRoot test override).
      // The returned entry preserves the LLM's ORIGINAL path string for
      // legibility in the `### <path>` heading.
      const stripped = pathStr.replace(/^\/+/, '');
      const isCampaignPath = stripped.startsWith('campaigns/');
      const effectiveRoot = isCampaignPath ? VAULT_CAMPAIGNS_ROOT : vaultRoot;
      const effectivePath = isCampaignPath ? '/' + stripped.slice('campaigns/'.length) : pathStr;
      // readVaultFile already returns inline error markers on bad paths /
      // missing files — per-file errors don't fail the batch (spike 009).
      const content = await readVaultFile(effectivePath, effectiveRoot);
      entries.push({ path: pathStr, content });
    }
    return { content: formatMultiReadResult(entries), isError: false };
  }

  if (name === 'list_vault') {
    const raw = (input ?? {}) as { directory?: unknown };
    if (typeof raw.directory !== 'string') {
      return { content: 'ERROR: list_vault requires a string `directory` argument', isError: true };
    }
    // Decision 4 — root routing (mirror of read_vault_multi). `/campaigns/...`
    // listing routes to VAULT_CAMPAIGNS_ROOT; everything else stays under
    // VAULT_ROOT.
    const stripped = raw.directory.replace(/^\/+/, '');
    const isCampaignPath = stripped.startsWith('campaigns/');
    const effectiveRoot = isCampaignPath ? VAULT_CAMPAIGNS_ROOT : vaultRoot;
    const effectivePath = isCampaignPath ? '/' + stripped.slice('campaigns/'.length) : raw.directory;
    const children = await listVaultDir(effectivePath, effectiveRoot);
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

  if (name === 'apply_event') {
    const raw = (input ?? {}) as { type?: unknown; payload?: unknown };
    if (typeof raw.type !== 'string' || typeof raw.payload !== 'object' || raw.payload === null) {
      return { content: 'ERROR: apply_event requires {type: string, payload: object}', isError: true };
    }
    if (!ctx?.campaignId) {
      return {
        content: 'ERROR: apply_event requires campaignId in dispatch context (server-side; cannot be supplied by LLM)',
        isError: true,
      };
    }
    if (!UUID_REGEX.test(ctx.campaignId)) {
      return {
        content: `ERROR: apply_event campaignId is not a valid UUID: ${ctx.campaignId}`,
        isError: true,
      };
    }

    // Validate event shape (hand-rolled type guard, no zod — Decision 1).
    const guarded = validateEvent({ type: raw.type, payload: raw.payload as Record<string, unknown> });
    if (!guarded.ok) {
      return { content: `ERROR: ${guarded.error}`, isError: true };
    }

    // NIT 1 enforcement (Phase 02 smoke 2026-05-26): the `character` field
    // in mutation event payloads MUST be a UUID matching a character in the
    // materialized view frontmatter. Without this guard the model invents
    // identifiers like "pc-001" or "luffy" — events land but the projector
    // can't match them to any character, producing zombie state. The type
    // schema declares `character: string`, not `character: UUID`, so the
    // check belongs here at the dispatch boundary, not inside validateEvent.
    // `campaign_initialized` (seed event) has no `character` field — skip it.
    if (guarded.value.type !== 'campaign_initialized') {
      const characterId = (guarded.value.payload as { character?: unknown }).character;
      if (typeof characterId !== 'string' || !UUID_REGEX.test(characterId)) {
        return {
          content: `ERROR: apply_event payload.character must be a UUID matching a character in the campaign (got: ${JSON.stringify(characterId)}). Read the characters/<slug>.md materialized view frontmatter and copy the value of the 'id' field.`,
          isError: true,
        };
      }
    }

    // Build the canonical event envelope. Timestamp is metadata only —
    // the projector is PURE and does not consume it. The version field
    // allows Phase 03+ schema migrations per spike 008.
    const envelope: VaultEventEnvelope = {
      id: randomUUID(),
      version: EVENT_SCHEMA_VERSION,
      type: guarded.value.type,
      payload: guarded.value.payload,
      timestamp: new Date().toISOString(),
    };

    try {
      // Persist (mutex-serialized — spike 010 pattern).
      await EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope);
      // Regenerate the affected view synchronously (Decision 2 — cheap; <5ms typical).
      await regenerateAffectedViews(ctx.campaignId, envelope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: apply_event failed during persist: ${message}`, isError: true };
    }

    // Minimal success envelope (Decision 3 — preserves prefix-cache hygiene).
    return { content: JSON.stringify({ ok: true, event_id: envelope.id }), isError: false };
  }

  return { content: 'ERROR: unknown vault tool: ' + name, isError: true };
}
