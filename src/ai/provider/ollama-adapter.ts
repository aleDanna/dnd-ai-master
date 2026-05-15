import type { SystemBlock, Message, ToolDef, ContentBlock, NormalizedUsage } from './types';

/** Ollama /api/chat message shape. */
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface OllamaResponseMessage {
  role: 'assistant';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaUsage {
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Joins Anthropic system blocks into a single Ollama system message.
 *  Returns null when the list is empty so callers can omit the slot. */
export function anthropicSystemToOllamaMessage(blocks: SystemBlock[]): OllamaMessage | null {
  if (blocks.length === 0) return null;
  return { role: 'system', content: blocks.map((b) => b.text).join('\n\n') };
}

/** Converts Anthropic message history to Ollama's flat messages array.
 *  Tool results fan out into separate role:'tool' entries. */
export function anthropicMessagesToOllama(messages: Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: OllamaToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.input as Record<string, unknown> },
          });
        }
      }
      const assistantMsg: OllamaMessage = { role: 'assistant', content: text };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
      continue;
    }
    // user role with blocks — fan out tool_results
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
            : '';
        out.push({ role: 'tool', content, tool_call_id: block.tool_use_id });
      } else if (block.type === 'text') {
        out.push({ role: 'user', content: block.text });
      }
    }
  }
  return out;
}

/** Renames input_schema → parameters for Ollama's function-tool format. */
export function anthropicToolToOllama(tool: ToolDef): OllamaTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as unknown,
    },
  };
}

/** Converts the Ollama response message into our canonical content blocks.
 *  Synthesizes a UUID for any tool_call that lacks an `id` field. */
export function ollamaResponseToContentBlocks(msg: OllamaResponseMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.content && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: tc.id ?? crypto.randomUUID(),
      name: tc.function.name,
      input: tc.function.arguments ?? {},
    });
  }
  return blocks;
}

/** Maps Ollama's done_reason field to our canonical stopReason. The presence
 *  of tool_calls promotes a 'stop' reason to 'tool_use'. */
export function ollamaDoneReasonToStopReason(
  done: string | undefined,
  hasToolCalls: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'other' {
  if (done === 'length') return 'max_tokens';
  if (done === 'stop') return hasToolCalls ? 'tool_use' : 'end_turn';
  return 'other';
}

/** Normalizes Ollama usage counts to our canonical shape. Cache fields are
 *  always 0 (Ollama has no prompt-cache concept). */
export function normalizeOllamaUsage(u: OllamaUsage): NormalizedUsage {
  return {
    inputTokens: u.prompt_eval_count ?? 0,
    outputTokens: u.eval_count ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}
