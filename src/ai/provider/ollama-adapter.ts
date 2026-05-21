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

/** Some thinking models (qwen3, deepseek-r1) ignore the API-level `think: false`
 *  flag and emit their chain-of-thought wrapped in `<think>…</think>` tags
 *  inside `message.content`. The player must NOT see this internal reasoning.
 *  Strip everything up to and including the closing tag (last occurrence wins,
 *  in case the model nests). When no closing tag is present, the content is
 *  returned verbatim — assumed to be regular narration. */
export function stripThinkingFromContent(content: string): string {
  const idx = content.lastIndexOf('</think>');
  if (idx === -1) return content;
  return content.slice(idx + '</think>'.length).trimStart();
}

/** Known meta-tool names emitted by the local provider's meta-tool catalogue.
 *  Kept in sync with META_TOOL_DEFINITIONS in engine/tools/meta-tools.ts.
 *  Used as the whitelist for inline-tool-call recovery (below) so we don't
 *  parse arbitrary `name({...})` patterns out of narrative prose. */
const RECOVERABLE_TOOL_NAMES: readonly string[] = [
  'combat_action',
  'spell_action',
  'inventory_action',
  'character_action',
  'rest_action',
  'narrative_action',
  'environment_action',
  'meta_action',
];

/** Some local bases — notably gpt-oss:20b under a large prompt context —
 *  emit tool calls inline in `content` as `name({...json...})` text rather
 *  than in the structured `tool_calls` field, even when `tools` is passed
 *  in the request. (qwen3 with a large prompt instead emits an empty
 *  content + null tool_calls; that path is not recoverable here and needs
 *  a smaller prompt or model swap.)
 *
 *  This function recovers the text-format case. Match is strict: the
 *  ENTIRE content must be only a tool-call invocation (whitespace
 *  tolerated). We don't false-positive on narration that happens to
 *  mention a tool name. The name must be in `RECOVERABLE_TOOL_NAMES`
 *  and the arguments must parse as strict JSON.
 *
 *  Returns the recovered tool call or null when content doesn't match. */
export function recoverInlineToolCall(content: string): {
  name: string;
  input: Record<string, unknown>;
} | null {
  const namesGroup = RECOVERABLE_TOOL_NAMES.join('|');
  const re = new RegExp(`^\\s*(${namesGroup})\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)\\s*$`);
  const m = re.exec(content);
  if (!m) return null;
  try {
    const args = JSON.parse(m[2]!);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    return { name: m[1]!, input: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Converts the Ollama response message into our canonical content blocks.
 *  Synthesizes a UUID for any tool_call that lacks an `id` field.
 *
 *  When `tool_calls` is absent but `content` is a bare `name({...})` text
 *  invocation, recover it as a structured tool_use block — see
 *  `recoverInlineToolCall` for the rationale. */
export function ollamaResponseToContentBlocks(msg: OllamaResponseMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const cleanContent = msg.content ? stripThinkingFromContent(msg.content) : '';

  // Text-format tool-call recovery (defensive). Only kicks in when the
  // structured channel is empty AND the entire content looks like a
  // tool-call literal. The text block is suppressed when recovered so
  // the player doesn't see the JSON envelope.
  let suppressText = false;
  if (!msg.tool_calls?.length && cleanContent.length > 0) {
    const recovered = recoverInlineToolCall(cleanContent);
    if (recovered) {
      blocks.push({
        type: 'tool_use',
        id: crypto.randomUUID(),
        name: recovered.name,
        input: recovered.input,
      });
      suppressText = true;
    }
  }

  if (!suppressText && cleanContent.length > 0) {
    blocks.push({ type: 'text', text: cleanContent });
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
