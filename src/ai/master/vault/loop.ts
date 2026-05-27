import { eq } from 'drizzle-orm';
import type {
  MasterProvider,
  Message,
  NormalizedUsage,
  SystemBlock,
} from '@/ai/provider/types';
import {
  VAULT_TURN_TOOL_CALL_CAP,
  TURN_TIMEOUT_MS,
  type TurnEvent,
} from '@/sessions/types';
import { stripReasoningPreamble } from '@/ai/master/reasoning-strip';
import { VAULT_TOOL_DEFINITIONS, dispatchVaultTool } from './tools';
import { maybeCondense } from './condense';
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';

/**
 * REQ-010, REQ-013, REQ-021 — Parallel-to-`runToolLoop` orchestrator for
 * the vault path.
 *
 * Calls the existing MasterProvider interface (so Ollama / cloud
 * streaming, KV-cache hygiene, onDelta / onThinking plumbing are reused
 * for free), dispatches the 3 Phase-01 vault tools via `dispatchVaultTool`,
 * and accepts BOTH terminators:
 *   1. `end_turn` tool call (the model's explicit terminator)
 *   2. `no_tool_calls + content` (the model returns plain text with no
 *      tool calls — observed 40% of the time on qwen3:30b-a3b base; REQ-013)
 *
 * Intentionally NOT a refactor of the existing tool loop. The existing
 * loop is tightly coupled to engine plumbing — forcing the vault path
 * through it would either require gutless nullable injections or invasive
 * branching. This is ~250 LOC vs ~330 because it drops meta-tools,
 * required-tools-before-end, DB persistence, mutation events, and
 * engine handler lookups.
 *
 * It KEEPS streaming, usage telemetry, the tool-call cap, timeout
 * budgeting, dual terminator handling, and the TurnEvent shape so SSE
 * subscribers (`notifySession`) keep working unchanged.
 *
 * Default tool-call cap is `VAULT_TURN_TOOL_CALL_CAP = 20` (higher than
 * the baked loop's `TURN_TOOL_CALL_CAP = 12`) to accommodate combat turns
 * with many `apply_event` calls — see RESEARCH Pitfall 4.
 */

export interface VaultLoopInput {
  provider: MasterProvider;
  model?: string;
  systemBlocks: SystemBlock[];
  history: Message[];
  /** Overrides VAULT_ROOT for tests; production callers omit. */
  vaultRoot?: string;
  /**
   * Campaign UUID — required for `apply_event` (Phase 02). Forwarded into
   * `dispatchVaultTool` as `ctx.campaignId`. When undefined, apply_event
   * calls from the LLM return isError. Phase 01 read-only flows omit this
   * and continue working.
   */
  campaignId?: string;
  /**
   * Phase 03-A — when `true`, every `apply_event` tool call fans out
   * through `dualWriteApplyEvent` (parallel vault + Postgres write +
   * parity-check). Forwarded into `dispatchVaultTool` as `ctx.dualWrite`.
   * Resolved by the turn-route from `campaign.settings.dualWrite` via
   * `resolveDualWrite` (plan 03-B-01). Default false (Phase 02 single-write).
   */
  dualWrite?: boolean;
  /** Telemetry sink — receives every `provider.completeMessage` usage. */
  recordUsage?: (u: NormalizedUsage) => Promise<void>;
  /** SSE event sink — fires per `narrative_delta`, `tool_use_*`, etc. */
  onEvent?: (e: TurnEvent) => void;
  /**
   * Phase 03-A — sessionId is now a dual-purpose field:
   *  1. Telemetry / language detection plumbing (Phase 01/02 use).
   *  2. Forwarded into `dispatchVaultTool` as `ctx.sessionId` so the
   *     dual-write dispatcher can address the Postgres parity-check target
   *     (`session_state` is keyed on sessionId, NOT campaignId).
   */
  sessionId?: string;
  campaignLanguage?: string;
  /** Test override; production omits and uses `VAULT_TURN_TOOL_CALL_CAP`. */
  toolCallCap?: number;
  /** Test override; production omits and uses `TURN_TIMEOUT_MS`. */
  turnTimeoutMs?: number;
}

/**
 * Phase 03-A — pull the character UUID out of an `apply_event` tool input
 * for forwarding into the dispatch context's `characterId` field. Returns
 * `null` for any tool other than `apply_event`, and for `apply_event` with
 * an absent/malformed `payload.character` (the dispatcher's NIT 1 guard
 * will then ERROR the call inside `dispatchVaultTool` — the loop does not
 * need to pre-validate).
 *
 * For `apply_event` with the `campaign_initialized` seed type, the payload
 * carries `characters[]` instead of `character` — returns null so the
 * dispatcher's dual-writer skips the parity-check (which is per-character).
 */
function extractCharacterIdFromToolInput(
  name: string,
  input: Record<string, unknown>,
): string | null {
  if (name !== 'apply_event') return null;
  const payload = input.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const character = (payload as { character?: unknown }).character;
  if (typeof character !== 'string' || character.length === 0) return null;
  return character;
}

export interface VaultLoopResult {
  events: TurnEvent[];
  finalText: string;
  toolCallCount: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function runVaultToolLoop(input: VaultLoopInput): Promise<VaultLoopResult> {
  const {
    provider,
    model,
    systemBlocks,
    history,
    vaultRoot,
    campaignId,
    dualWrite,
    recordUsage,
    onEvent,
    sessionId,
    campaignLanguage,
  } = input;
  const toolCallCap = input.toolCallCap ?? VAULT_TURN_TOOL_CALL_CAP;
  const turnTimeoutMs = input.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  const events: TurnEvent[] = [];
  const emit = (ev: TurnEvent): void => {
    events.push(ev);
    onEvent?.(ev);
  };

  // `let` (not `const`) — Phase 03-B reassigns when `maybeCondense` fires.
  let messages: Message[] = [...history];

  // Phase 03-B (REQ-023) — restore persisted summary on restart (Pitfall 4).
  // When a session resumes after a Next.js restart, we read the previously
  // persisted summary block from `session_state.summaryBlock` and inject it
  // RIGHT AFTER the first history message as a `[Riassunto ...]` user turn.
  // This avoids re-summarizing on every cold start of an already-condensed
  // session (which would waste 1-3s + a provider round-trip).
  //
  // Failures here are NON-FATAL: a DB outage shouldn't kill the turn. We
  // log to console.warn and proceed with the unaugmented history; the next
  // `maybeCondense` call will re-create the summary if still needed.
  if (sessionId) {
    try {
      const [stateRow] = await db
        .select({ summaryBlock: sessionState.summaryBlock })
        .from(sessionState)
        .where(eq(sessionState.sessionId, sessionId))
        .limit(1);
      if (stateRow?.summaryBlock?.text && messages.length > 0) {
        const anchor = messages[0]!;
        const rest = messages.slice(1);
        messages = [
          anchor,
          {
            role: 'user',
            content: `[Riassunto dei turni precedenti]\n${stateRow.summaryBlock.text}`,
          },
          ...rest,
        ];
      }
    } catch (e) {
      console.warn(
        '[vault-loop] summaryBlock restore failed:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  let finalText = '';
  let toolCallCount = 0;
  let truncated = false;
  let timedOut = false;
  const start = Date.now();

  for (let iter = 0; iter <= toolCallCap; iter += 1) {
    if (Date.now() - start > turnTimeoutMs) {
      timedOut = true;
      emit({ type: 'turn_error', reason: 'timeout', recoverable: true });
      break;
    }

    // Phase 03-B (REQ-023) — per-turn summarization at threshold. Fires
    // when the in-loop history exceeds MASTER_SUMMARIZE_TRIGGER tokens
    // (default 15K). When `condense.condensed === true`, the working
    // messages array is REPLACED with `[anchor, summary, ...recent]` and
    // a `summarized` event is emitted for SSE subscribers. The summary is
    // simultaneously persisted to `session_state.summaryBlock` inside
    // `maybeCondense` for restart-safety.
    //
    // Requires a `sessionId` and a `model` — without either, the summarizer
    // cannot persist or pick the right backing model (REQ-034 forbids a
    // per-turn router), so we skip silently. Phase 02 behavior is preserved
    // when `MASTER_SUMMARIZATION=off` OR token count is below threshold —
    // the kill-switch lives inside `maybeCondense` and reads env on every
    // call so production toggling works without a Next.js restart.
    if (sessionId && model) {
      const condense = await maybeCondense(messages, provider, model, sessionId);
      messages = condense.history;
      if (condense.condensed) {
        emit({
          type: 'summarized',
          tokensBefore: condense.tokensBefore,
          tokensAfter: condense.tokensAfter,
        });
      }
    }

    let streamedAny = false;
    const response = await provider.completeMessage({
      systemBlocks,
      messages,
      tools: VAULT_TOOL_DEFINITIONS,
      ...(model !== undefined && { model }),
      ...(sessionId !== undefined && { sessionId }),
      ...(campaignLanguage !== undefined && { campaignLanguage }),
      onDelta: (text: string) => {
        if (text.length === 0) return;
        streamedAny = true;
        emit({ type: 'narrative_delta', text });
      },
      onThinking: (state: 'start' | 'end') => emit({ type: 'thinking', state }),
    });

    if (recordUsage) await recordUsage(response.usage);

    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const block of response.contentBlocks) {
      if (block.type === 'text') {
        const stripped = stripReasoningPreamble(block.text);
        if (stripped.length > 0) {
          finalText += stripped;
          if (!streamedAny) emit({ type: 'narrative_delta', text: stripped });
        }
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    // Terminator 1 — no_tool_calls + content. The model returned only
    // text; `finalText` is already populated. (REQ-013)
    if (toolUses.length === 0) break;

    // Terminator 2 — end_turn tool call (REQ-013 / REQ-010).
    const endTurnCall = toolUses.find((t) => t.name === 'end_turn');
    if (endTurnCall) {
      // end_turn does not consult dualWrite / sessionId / characterId in the
      // dispatcher, but we forward them for consistency so a future tool
      // that wants per-call audit metadata has them available.
      const result = await dispatchVaultTool('end_turn', endTurnCall.input, {
        vaultRoot,
        campaignId,
        dualWrite,
        sessionId,
        characterId: extractCharacterIdFromToolInput('end_turn', endTurnCall.input),
      });
      finalText = result.endTurnResponse ?? finalText;
      emit({
        type: 'tool_use_start',
        toolUseId: endTurnCall.id,
        name: 'end_turn',
        input: endTurnCall.input,
      });
      emit({
        type: 'tool_use_end',
        toolUseId: endTurnCall.id,
        ok: true,
        rolls: [],
        mutationCount: 0,
      });
      break;
    }

    // Tool-cap check (count tool_uses against the cap BEFORE incrementing).
    if (toolCallCount + toolUses.length > toolCallCap) {
      truncated = true;
      emit({ type: 'turn_error', reason: 'tool_call_cap', recoverable: true });
      break;
    }

    // Push the assistant turn back into history (Anthropic shape). Drop
    // empty text blocks (Anthropic rejects them in assistant turns).
    messages.push({
      role: 'assistant',
      content: response.contentBlocks
        .filter((b) => b.type !== 'text' || b.text.length > 0)
        .map((b) =>
          b.type === 'text'
            ? ({ type: 'text', text: b.text } as never)
            : ({ type: 'tool_use', id: b.id, name: b.name, input: b.input } as never),
        ),
    });

    const toolResults: {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }[] = [];
    for (const tu of toolUses) {
      toolCallCount += 1;
      emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input });
      // Phase 03-A — extract the per-event character UUID at dispatch time
      // and forward dualWrite + sessionId so the apply_event branch can
      // decide whether to fan-out. Tools other than apply_event are
      // unaffected (the dispatcher only consults these fields inside the
      // apply_event branch).
      const result = await dispatchVaultTool(tu.name, tu.input, {
        vaultRoot,
        campaignId,
        dualWrite,
        sessionId,
        characterId: extractCharacterIdFromToolInput(tu.name, tu.input),
      });
      emit({
        type: 'tool_use_end',
        toolUseId: tu.id,
        ok: !result.isError,
        ...(result.isError && { error: result.content }),
        rolls: [],
        mutationCount: 0,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    messages.push({ role: 'user', content: toolResults as never });
  }

  return { events, finalText, toolCallCount, truncated, timedOut };
}
