import type { ActionResult, EngineState, Mutation, DiceRoll } from '@/engine/types';
import type { AnthropicTool } from '@/engine/types';
import { TOOL_HANDLERS, TOOL_DEFINITIONS, TOOL_HANDLERS_DB } from '@/engine';
import { dispatchMetaCall } from '@/engine/tools/meta-dispatcher';
import { TURN_TOOL_CALL_CAP, TURN_TIMEOUT_MS, type TurnEvent } from '@/sessions/types';
import type {
  MasterProvider,
  Message,
  NormalizedUsage,
  SystemBlock,
} from '@/ai/provider/types';
import { stripReasoningPreamble } from './reasoning-strip';

export interface ToolLoopInput {
  provider: MasterProvider;
  /** Optional override; provider falls back to its env-configured master model. */
  model?: string;
  systemBlocks: SystemBlock[];
  history: Message[];
  state: EngineState;
  /** Optional applicator: called after each tool result with the mutations. */
  applyMutations?: (mutations: Mutation[], rolls: DiceRoll[]) => Promise<void>;
  /** Optional usage sink (called once per round-trip). */
  recordUsage?: (usage: NormalizedUsage) => Promise<void>;
  /** Called once per emitted event, in order. Use to flush events to an SSE stream as they happen. */
  onEvent?: (event: TurnEvent) => void;
  /** Used as OpenAI prompt_cache_key for cache affinity (Anthropic ignores). */
  sessionId?: string;
  /** Tool definitions for this turn. Defaults to TOOL_DEFINITIONS for back-compat with existing tests. */
  tools?: AnthropicTool[];
}

export interface ToolLoopResult {
  events: TurnEvent[];
  finalText: string;
  toolCallCount: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const {
    provider,
    model,
    systemBlocks,
    history,
    state,
    applyMutations,
    recordUsage,
    onEvent,
    sessionId,
    tools = TOOL_DEFINITIONS,
  } = input;
  const events: TurnEvent[] = [];
  let finalText = '';
  let toolCallCount = 0;
  let truncated = false;
  let timedOut = false;
  const start = Date.now();
  const messages: Message[] = [...history];

  const emit = (ev: TurnEvent): void => {
    events.push(ev);
    onEvent?.(ev);
  };

  for (let iter = 0; iter < TURN_TOOL_CALL_CAP + 1; iter++) {
    if (Date.now() - start > TURN_TIMEOUT_MS) {
      timedOut = true;
      emit({ type: 'turn_error', reason: 'timeout', recoverable: true });
      break;
    }

    // Streaming: provider invokes onDelta for each token chunk as it
    // arrives. We pump those straight to the SSE stream so the UI sees
    // tokens live (TTFT ~1s instead of wait-for-full-response). Currently
    // only LocalProvider honours onDelta; cloud providers ignore it and
    // we fall through to the single-shot emission below.
    let streamedAny = false;
    const response = await provider.completeMessage({
      model,
      systemBlocks,
      messages,
      tools,
      sessionId,
      onDelta: (text: string) => {
        streamedAny = true;
        emit({ type: 'narrative_delta', text });
      },
    });

    if (recordUsage) await recordUsage(response.usage);

    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const block of response.contentBlocks) {
      if (block.type === 'text') {
        const cleaned = stripReasoningPreamble(block.text);
        block.text = cleaned;
        if (cleaned) {
          finalText += cleaned;
          // Re-emit only if we did NOT stream (cloud providers or local
          // without streaming). When streaming, the UI already received
          // these tokens incrementally; re-emitting would duplicate.
          if (!streamedAny) {
            emit({ type: 'narrative_delta', text: cleaned });
          }
        }
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    if (toolUses.length === 0 || response.stopReason === 'end_turn') break;

    if (toolCallCount + toolUses.length > TURN_TOOL_CALL_CAP) {
      truncated = true;
      emit({ type: 'turn_error', reason: 'tool_call_cap', recoverable: true });
      break;
    }

    // Push the assistant turn back into history (Anthropic-shape). Drop any
    // text blocks that the reasoning-strip emptied — Anthropic rejects empty
    // text blocks in assistant turns.
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

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }[] = [];
    for (const tu of toolUses) {
      toolCallCount += 1;
      emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input });

      // Meta-dispatch: rewrites local-provider meta calls (combat_action,
      // spell_action, …) into the underlying engine tool name + stripped
      // input. Plain tool names pass through unchanged. Errors here surface
      // as tool_result errors (e.g. unknown subaction).
      let resolvedName = tu.name;
      let resolvedInput = tu.input;
      let dispatchError: string | null = null;
      try {
        const dispatched = dispatchMetaCall(tu.name, tu.input);
        resolvedName = dispatched.resolvedName;
        resolvedInput = dispatched.resolvedInput;
      } catch (e) {
        dispatchError = e instanceof Error ? e.message : String(e);
      }

      const syncHandler = !dispatchError ? TOOL_HANDLERS[resolvedName] : undefined;
      const dbHandler = !dispatchError ? TOOL_HANDLERS_DB[resolvedName] : undefined;
      let result: ActionResult;
      if (dispatchError) {
        result = { ok: false, error: dispatchError, rolls: [], mutations: [] };
      } else if (syncHandler) {
        try {
          result = syncHandler(state, resolvedInput);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
        }
      } else if (dbHandler) {
        if (!sessionId) {
          result = { ok: false, error: 'missing_session_for_db_tool', rolls: [], mutations: [] };
        } else {
          try {
            result = await dbHandler({ sessionId }, state, resolvedInput);
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
          }
        }
      } else {
        result = { ok: false, error: `unknown_tool:${resolvedName}`, rolls: [], mutations: [] };
      }

      emit({
        type: 'tool_use_end',
        toolUseId: tu.id,
        ok: result.ok,
        error: result.error,
        rolls: result.rolls,
        mutationCount: result.mutations.length,
      });

      // Persist mutations + rolls BEFORE pushing the tool_result back to the
      // model. A persistence failure here used to crash the whole turn — the
      // master's narration was lost and the player saw a 500 with no reply.
      // Now we catch it, mark the tool as failed so the master can react, and
      // continue. The transaction rolls back internally so partial state is
      // not saved.
      let persistError: string | null = null;
      if (result.mutations.length > 0 || result.rolls.length > 0) {
        if (applyMutations) {
          try {
            await applyMutations(result.mutations, result.rolls);
          } catch (e) {
            persistError = e instanceof Error ? e.message : String(e);
          }
        }
        if (!persistError) emit({ type: 'state_changed', mutations: result.mutations });
      }

      const finalOk = result.ok && !persistError;
      const finalError = persistError ? `persistence_failed: ${persistError}` : result.error;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ ok: finalOk, data: result.data, error: finalError, rolls: result.rolls }),
        is_error: !finalOk,
      });
    }

    messages.push({ role: 'user', content: toolResults as never });
  }

  return { events, finalText, toolCallCount, truncated, timedOut };
}
