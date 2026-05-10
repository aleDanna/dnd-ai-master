import type { ActionResult, EngineState, Mutation, DiceRoll } from '@/engine/types';
import type { AnthropicTool } from '@/engine/types';
import { TOOL_HANDLERS, TOOL_DEFINITIONS, TOOL_HANDLERS_DB } from '@/engine';
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

    const response = await provider.completeMessage({
      model,
      systemBlocks,
      messages,
      tools,
      sessionId,
    });

    if (recordUsage) await recordUsage(response.usage);

    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const block of response.contentBlocks) {
      if (block.type === 'text') {
        const cleaned = stripReasoningPreamble(block.text);
        block.text = cleaned;
        if (cleaned) {
          finalText += cleaned;
          emit({ type: 'narrative_delta', text: cleaned });
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

      const syncHandler = TOOL_HANDLERS[tu.name];
      const dbHandler = TOOL_HANDLERS_DB[tu.name];
      let result: ActionResult;
      if (syncHandler) {
        try {
          result = syncHandler(state, tu.input);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
        }
      } else if (dbHandler) {
        if (!sessionId) {
          result = { ok: false, error: 'missing_session_for_db_tool', rolls: [], mutations: [] };
        } else {
          try {
            result = await dbHandler({ sessionId, state }, tu.input);
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
          }
        }
      } else {
        result = { ok: false, error: `unknown_tool:${tu.name}`, rolls: [], mutations: [] };
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
