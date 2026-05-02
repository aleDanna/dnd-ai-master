import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { Message, ToolDef } from '@/ai/provider/types';
import {
  anthropicToolToOpenAI,
  flattenSystemBlocks,
  anthropicMessagesToOpenAI,
  openAIResponseToContentBlocks,
  openAIFinishReasonToStopReason,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
} from '@/ai/provider/tool-adapter';

describe('tool-adapter', () => {
  it('converts Anthropic tool def → OpenAI function', () => {
    const tool: ToolDef = {
      name: 'roll_d20',
      description: 'roll a d20',
      input_schema: {
        type: 'object',
        required: ['mod'],
        properties: { mod: { type: 'number' } },
      } as never,
    };
    const out = anthropicToolToOpenAI(tool);
    expect(out.type).toBe('function');
    expect(out.function.name).toBe('roll_d20');
    expect(out.function.description).toBe('roll a d20');
    expect(out.function.parameters).toEqual(tool.input_schema);
  });

  it('flattens system blocks and drops cache_control', () => {
    const flat = flattenSystemBlocks([
      { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'B' },
    ]);
    expect(flat).toBe('A\n\nB');
    expect(flat).not.toMatch(/cache_control/);
  });

  it('passes user string message through', () => {
    const out = anthropicMessagesToOpenAI([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('collapses assistant text blocks into a single string', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi ', citations: null } as never,
          { type: 'text', text: 'there.', citations: null } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out).toEqual([{ role: 'assistant', content: 'Hi there.' }]);
  });

  it('converts assistant text + tool_use → assistant + tool_calls', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Rolling…', citations: null } as never,
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { mod: 3 } } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out.length).toBe(1);
    const a = out[0] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(a.role).toBe('assistant');
    expect(a.content).toBe('Rolling…');
    expect(a.tool_calls).toEqual([
      { id: 'tu1', type: 'function', function: { name: 'roll_d20', arguments: '{"mod":3}' } },
    ]);
  });

  it('fans out N tool_result blocks into N OpenAI tool messages', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok-1', is_error: false } as never,
          { type: 'tool_result', tool_use_id: 'tu2', content: 'err', is_error: true } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ role: 'tool', content: 'ok-1', tool_call_id: 'tu1' });
    expect(out[1]).toEqual({ role: 'tool', content: 'err', tool_call_id: 'tu2' });
  });

  it('OpenAI text-only response → text content block', () => {
    const msg = {
      role: 'assistant',
      content: 'You see a dragon.',
      refusal: null,
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out).toEqual([{ type: 'text', text: 'You see a dragon.' }]);
  });

  it('OpenAI tool_calls-only response → tool_use blocks (with JSON.parse)', () => {
    const msg = {
      role: 'assistant',
      content: null,
      refusal: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'roll_d20', arguments: '{"mod":5}' },
        },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'roll_d20', input: { mod: 5 } },
    ]);
  });

  it('OpenAI mixed text + tool_calls → mixed blocks', () => {
    const msg = {
      role: 'assistant',
      content: 'Rolling…',
      refusal: null,
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'roll_d20', arguments: '{}' },
        },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out[0]).toEqual({ type: 'text', text: 'Rolling…' });
    expect(out[1]).toEqual({ type: 'tool_use', id: 'call_a', name: 'roll_d20', input: {} });
  });

  it('finish_reason maps + usage normalizes for both providers', () => {
    expect(openAIFinishReasonToStopReason('stop')).toBe('end_turn');
    expect(openAIFinishReasonToStopReason('tool_calls')).toBe('tool_use');
    expect(openAIFinishReasonToStopReason('length')).toBe('max_tokens');
    expect(openAIFinishReasonToStopReason('content_filter')).toBe('other');

    const aUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    } as Anthropic.Messages.Usage;
    expect(normalizeAnthropicUsage(aUsage)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
    });

    const oUsage = {
      prompt_tokens: 200,
      completion_tokens: 75,
      total_tokens: 275,
      prompt_tokens_details: { cached_tokens: 150 },
    } as OpenAI.Completions.CompletionUsage;
    expect(normalizeOpenAIUsage(oUsage)).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cacheReadTokens: 150,
      cacheCreationTokens: 0,
    });

    // undefined OpenAI usage (rare but possible) returns zeros
    expect(normalizeOpenAIUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('OpenAI tool_call with malformed JSON arguments → _raw fallback', () => {
    const msg = {
      role: 'assistant',
      content: null,
      refusal: null,
      tool_calls: [
        {
          id: 'c',
          type: 'function',
          function: { name: 'r', arguments: '{ not json' },
        },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out).toEqual([
      { type: 'tool_use', id: 'c', name: 'r', input: { _raw: '{ not json' } },
    ]);
  });

  it('drops text alongside tool_result blocks in the same user message (OpenAI constraint)', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'lost narration' } as never,
          { type: 'tool_result', tool_use_id: 'tu', content: 'r', is_error: false } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out).toEqual([{ role: 'tool', content: 'r', tool_call_id: 'tu' }]);
  });
});
