import type Anthropic from '@anthropic-ai/sdk';
import type { ActionResult, EngineState, Mutation, DiceRoll } from '@/engine/types';
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from '@/engine';
import { TURN_TOOL_CALL_CAP, TURN_TIMEOUT_MS, type TurnEvent } from '@/sessions/types';

export interface ToolLoopInput {
  client: Pick<Anthropic, 'messages'>;
  model: string;
  systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  history: Anthropic.Messages.MessageParam[];
  state: EngineState;
  /** Optional applicator: called after each tool result with the mutations. */
  applyMutations?: (mutations: Mutation[], rolls: DiceRoll[]) => Promise<void>;
  /** Optional usage sink (single call at end of loop). */
  recordUsage?: (usage: Anthropic.Messages.Usage) => Promise<void>;
  /** Called once per emitted event, in order. Use to flush events to an SSE stream as they happen. */
  onEvent?: (event: TurnEvent) => void;
}

export interface ToolLoopResult {
  events: TurnEvent[];
  finalText: string;
  toolCallCount: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const { client, model, systemBlocks, history, state, applyMutations, recordUsage, onEvent } = input;
  const events: TurnEvent[] = [];
  let finalText = '';
  let toolCallCount = 0;
  let truncated = false;
  let timedOut = false;
  const start = Date.now();
  const messages: Anthropic.Messages.MessageParam[] = [...history];

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

    const response: Anthropic.Messages.Message = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemBlocks,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    if (recordUsage) await recordUsage(response.usage);

    const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        finalText += block.text;
        emit({ type: 'narrative_delta', text: block.text });
      } else if (block.type === 'tool_use') {
        toolUses.push(block);
      }
    }

    if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
      break;
    }

    if (toolCallCount + toolUses.length > TURN_TOOL_CALL_CAP) {
      truncated = true;
      emit({ type: 'turn_error', reason: 'tool_call_cap', recoverable: true });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCallCount += 1;
      emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input as Record<string, unknown> });

      const handler = TOOL_HANDLERS[tu.name];
      let result: ActionResult;
      if (!handler) {
        result = { ok: false, error: `unknown_tool:${tu.name}`, rolls: [], mutations: [] };
      } else {
        try {
          result = handler(state, tu.input as Record<string, unknown>);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
        }
      }

      emit({
        type: 'tool_use_end',
        toolUseId: tu.id,
        ok: result.ok,
        error: result.error,
        rolls: result.rolls,
        mutationCount: result.mutations.length,
      });

      if (result.mutations.length > 0 || result.rolls.length > 0) {
        if (applyMutations) await applyMutations(result.mutations, result.rolls);
        emit({ type: 'state_changed', mutations: result.mutations });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ ok: result.ok, data: result.data, error: result.error, rolls: result.rolls }),
        is_error: !result.ok,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { events, finalText, toolCallCount, truncated, timedOut };
}
