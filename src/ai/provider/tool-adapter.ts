import type OpenAI from 'openai';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ContentBlock, Message, NormalizedUsage, SystemBlock, ToolDef } from './types';

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function anthropicToolToOpenAI(tool: ToolDef): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

/** Flatten Anthropic system blocks to a single string. cache_control is dropped — OpenAI auto-caches prompts ≥1024 tokens. */
export function flattenSystemBlocks(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

// ─── Messages: Anthropic → OpenAI ────────────────────────────────────────────

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function anthropicMessagesToOpenAI(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = msg.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      const tool_calls = toolUses.length
        ? toolUses.map((tu) => ({
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          }))
        : undefined;
      out.push({ role: 'assistant', content: text || null, ...(tool_calls ? { tool_calls } : {}) });
      continue;
    }

    // role === 'user' with content blocks
    const toolResults = msg.content.filter(
      (b): b is Anthropic.Messages.ToolResultBlockParam => b.type === 'tool_result',
    );
    if (toolResults.length > 0) {
      // Fan-out: one OpenAI tool message per result.
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          tool_call_id: tr.tool_use_id,
        });
      }
      // OpenAI does not allow text + tool_result in the same user message; drop the text part if any.
      continue;
    }

    // Plain user with text blocks
    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');
    out.push({ role: 'user', content: text });
  }
  return out;
}

// ─── Response: OpenAI → internal (Anthropic-shape) ───────────────────────────

export function openAIResponseToContentBlocks(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type !== 'function') continue;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
      } catch {
        parsed = { _raw: tc.function.arguments };
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsed });
    }
  }
  return blocks;
}

export function openAIFinishReasonToStopReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'],
): 'end_turn' | 'tool_use' | 'max_tokens' | 'other' {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

// ─── Usage normalization ──────────────────────────────────────────────────────

export function normalizeAnthropicUsage(usage: Anthropic.Messages.Usage): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export function normalizeOpenAIUsage(usage: OpenAI.Completions.CompletionUsage | undefined): NormalizedUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
  };
}
