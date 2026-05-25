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
  /** Telemetry sink — receives every `provider.completeMessage` usage. */
  recordUsage?: (u: NormalizedUsage) => Promise<void>;
  /** SSE event sink — fires per `narrative_delta`, `tool_use_*`, etc. */
  onEvent?: (e: TurnEvent) => void;
  sessionId?: string;
  campaignLanguage?: string;
  /** Test override; production omits and uses `VAULT_TURN_TOOL_CALL_CAP`. */
  toolCallCap?: number;
  /** Test override; production omits and uses `TURN_TIMEOUT_MS`. */
  turnTimeoutMs?: number;
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

  const messages: Message[] = [...history];
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
      const result = await dispatchVaultTool('end_turn', endTurnCall.input, { vaultRoot });
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
      const result = await dispatchVaultTool(tu.name, tu.input, { vaultRoot });
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
