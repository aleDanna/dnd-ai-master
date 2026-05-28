import { randomUUID } from 'node:crypto';
import type { ToolDef } from '@/ai/provider/types';
import { listVaultDir, readVaultFile, VAULT_CAMPAIGNS_ROOT } from './path';
import { validateEvent, EVENT_SCHEMA_VERSION, ENCOUNTER_EVENT_TYPES, type VaultEventEnvelope } from './events-schema';
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
 *
 * Phase 03 extension — Decision 10 (Completeness Audit):
 *   The `apply_event` tool description (this module) and the
 *   `VAULT_EVENT_TYPES` union (events-schema.ts) were extended in plan
 *   03-A-04 / 03-A-02 to cover the 20 additional event types enumerated
 *   in `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md`
 *   §"(c) Final list". The dispatcher itself does NOT need code changes —
 *   `validateEvent` (extended in plan 03-A-02) absorbs the new union
 *   members transparently, and the NIT 1 UUID guard below already applies
 *   to every non-`campaign_initialized` event (see comment block on the
 *   `apply_event` branch). The tool surface count stays at 4 (REQ-010
 *   unchanged).
 *
 *   Prompt-size tradeoff (plan 03-A-04 NIT 8): the Phase 03 description
 *   adds ~1.2KB of payload-shape hints to every turn's system-prompt
 *   tool surface. If `prompt_eval_count` becomes a bottleneck for local
 *   inference, future work can extract the per-type table into a
 *   one-time vault doc (`/tools/index.md`) referenced from a terse tool
 *   description. For Phase 03 the explicit-in-description form is
 *   retained — it puts the payload contract in front of the LLM on
 *   every turn, matching the spike 009 "explicit beats implicit"
 *   principle.
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
      'Append a game-state mutation event (HP, conditions, slots, inventory, temp HP, death saves, concentration, exhaustion, hit dice, resources, inspiration, attunement, focus, XP). Returns {ok, event_id} on success. One event per call; do not batch. Also drives combat encounters: combat_start, monster_spawn, initiative_set, turn_advance, monster_hp_change, combat_end (these have no payload.character — see payload description).',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Event type. One of: hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove, temp_hp_set, death_save_success, death_save_fail, death_save_stabilize, death_save_recover_at_one, concentration_set, concentration_break, exhaustion_increment, exhaustion_decrement, hit_dice_use, hit_dice_restore, resource_use, resource_restore, inspiration_grant, inspiration_spend, attune, unattune, focus_set, focus_unset, xp_award, combat_start, monster_spawn, initiative_set, turn_advance, monster_hp_change, combat_end.',
        },
        payload: {
          type: 'object',
          description:
            'Event-specific data. The `character` field is the character UUID (the value of `id` in the materialized view frontmatter — NOT the character name; names are not unique across campaigns). Per-type shapes — Phase 02: hp_change {character, delta:number}; condition_add/remove {character, condition:string}; spell_slot_use/restore {character, level:1-9}; inventory_add/remove {character, item:string, qty:1-999}. Phase 03: temp_hp_set {character, tempHp:0-999}; death_save_success/stabilize/recover_at_one {character}; death_save_fail {character, critical?:boolean}; concentration_set {character, spellSlug:string, slotLevel:0-9, startedRound:int>=0}; concentration_break {character, reason:"damage"|"killed"|"incapacitated"}; exhaustion_increment {character, source:string}; exhaustion_decrement {character}; hit_dice_use/restore {character, count:1-20}; resource_use/restore {character, resourceKey:string, uses:1-50}; inspiration_grant/spend {character}; attune/unattune {character, itemSlug:string<=64}; focus_set {character, kind:"arcane"|"druidic"|"holy"|"instrument", itemSlug:string}; focus_unset {character}; xp_award {character, amount:1-999999, reason?:string<=256}. Encounter events (no payload.character): combat_start {}; monster_spawn {id:string, name:string, hpMax:number, ac?:number, initiativeBonus?:number}; initiative_set {order:[{actorId:string, initiative:number}]}; turn_advance {}; monster_hp_change {id:string, delta:number}; combat_end {}.',
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
  /**
   * Phase 03-A — when `true`, the apply_event dispatcher fans the write out
   * via `dualWriteApplyEvent` (parallel write to vault + Postgres + sync
   * parity-check + fire-and-forget divergence record). When `false`/absent
   * (default), Phase 02 single-write behavior is preserved (vault-only).
   *
   * Resolved server-side from `campaign.settings.dualWrite` via
   * `resolveDualWrite` (plan 03-B-01). NEVER LLM-supplied — the LLM has no
   * visibility into the flag; the toggle is operator-only via the campaign
   * settings JSONB. Plan 03-A-10 forwards this through `VaultLoopInput`.
   */
  dualWrite?: boolean;
  /**
   * Phase 03-A — sessionId for the parity-check audit context. REQUIRED
   * when `dualWrite === true` (the audit row in `dual_write_divergences`
   * references the session FK; parityCheck reads `session_state` keyed on
   * sessionId). Defensive fallthrough: when `dualWrite === true` but
   * `sessionId` is absent, the dispatcher falls back to Phase 02
   * single-write (the gate fails closed, no fan-out attempted).
   *
   * Server-side from the validated Clerk session row — never LLM-supplied.
   */
  sessionId?: string;
  /**
   * Phase 03-A — character UUID for the parity-check target. The
   * dispatcher extracts this from the validated event payload at
   * dispatch time (`payload.character` is the UUID the LLM provides;
   * NIT 1 already enforces UUID shape). Pass `null` for events that
   * don't target a single character (e.g., a hypothetical session-level
   * event — none exist today). When null, `dualWriteApplyEvent` skips
   * the parity-check and returns `{ divergence: false }`.
   */
  characterId?: string | null;
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
    // Phase 07-D2: encounter-scoped events (ENCOUNTER_EVENT_TYPES) have no
    // `character` field either — the UUID guard must NOT apply to them.
    if (guarded.value.type !== 'campaign_initialized' && !ENCOUNTER_EVENT_TYPES.has(guarded.value.type)) {
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

    // Phase 03-A — dual-write gate. When the campaign opted into dual-write
    // (operator-set via campaign.settings.dualWrite; resolved by the route
    // and forwarded through VaultDispatchContext), fan the write out via
    // `dualWriteApplyEvent`: parallel vault append + Postgres mutation,
    // synchronous parity-check, fire-and-forget divergence record. The
    // sessionId guard is belt-and-suspenders — without sessionId the parity-
    // check cannot key its DB lookup, so we fail closed back to the Phase 02
    // path rather than attempt a half-configured dual-write.
    if (ctx.dualWrite === true && typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0) {
      // Dynamic import so the Phase 01/02 read-only path doesn't pay the
      // module-load cost for the Postgres dual-writer (which transitively
      // pulls in drizzle + the DB client). Keeps the test fixture surface
      // for read-only vault tests minimal.
      const { dualWriteApplyEvent } = await import('@/sessions/dual-writer');
      const { invokeEnginePathwayFromEvent } = await import('@/sessions/event-to-engine-mutation');

      // Extract the character UUID from the event payload. NIT 1 already
      // narrowed this to a UUID string for every non-campaign_initialized
      // event. campaign_initialized has no character payload — pass null
      // and dualWriteApplyEvent skips the parity-check.
      const characterId: string | null = ctx.characterId
        ?? (guarded.value.type === 'campaign_initialized'
          ? null
          : (guarded.value.payload as { character: string }).character);

      // The Postgres-leg callback. dualWriteApplyEvent dispatches this in
      // parallel with the vault append via Promise.all — failures of
      // EITHER leg reject and propagate as `isError: true` to the LLM.
      const applyEngineMutation = async (): Promise<void> => {
        await invokeEnginePathwayFromEvent(envelope, ctx.sessionId!, characterId);
      };

      try {
        const result = await dualWriteApplyEvent(
          envelope,
          applyEngineMutation,
          {
            campaignId: ctx.campaignId,
            sessionId: ctx.sessionId,
            characterId,
          },
        );
        return {
          // Carry the divergence reason back to the LLM in the success
          // envelope (only when divergence detected). The LLM does NOT
          // self-remediate — the field is informational so a curious
          // model can mention the issue in narration if it chooses; the
          // operator-side audit row in dual_write_divergences is the
          // authoritative record.
          content: JSON.stringify({
            ok: true,
            event_id: envelope.id,
            ...(result.divergence && result.reason ? { divergence: result.reason } : {}),
          }),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `ERROR: apply_event dual-write failed: ${message}`, isError: true };
      }
    }

    // Phase 02 single-write path — preserved verbatim for non-dual-write
    // campaigns (and as the fail-closed fallback when dualWrite is true
    // but sessionId is absent — see the gate above).
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
