import { describe, it, expect } from 'vitest';
import type { ToolDef } from '@/ai/provider/types';
import {
  anthropicToolToGemini,
  flattenSystemBlocksForGemini,
} from '@/ai/provider/gemini-adapter';

describe('gemini-adapter — system + tools', () => {
  it('flattens system blocks to a single instruction string and drops cache_control', () => {
    const out = flattenSystemBlocksForGemini([
      { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'B' },
    ]);
    expect(out).toEqual({ parts: [{ text: 'A\n\nB' }] });
  });

  it('returns null when there are no system blocks', () => {
    expect(flattenSystemBlocksForGemini([])).toBeNull();
  });

  it('converts a tool definition: input_schema → parameters, additionalProperties stripped', () => {
    const tool: ToolDef = {
      name: 'roll_d20',
      description: 'roll a d20',
      input_schema: {
        type: 'object',
        required: ['mod'],
        properties: { mod: { type: 'number' } },
        additionalProperties: false,
      } as never,
    };
    const out = anthropicToolToGemini(tool);
    expect(out.name).toBe('roll_d20');
    expect(out.description).toBe('roll a d20');
    expect(out.parameters).toEqual({
      type: 'object',
      required: ['mod'],
      properties: { mod: { type: 'number' } },
    });
  });

  it('handles tool with missing description (defaults to empty string)', () => {
    const tool: ToolDef = {
      name: 'noop',
      input_schema: { type: 'object', properties: {} } as never,
    };
    const out = anthropicToolToGemini(tool);
    expect(out.description).toBe('');
  });
});

import { anthropicMessagesToGemini } from '@/ai/provider/gemini-adapter';
import type { Message } from '@/ai/provider/types';

describe('gemini-adapter — messages', () => {
  it('passes user string message through as a parts:[{text}]', () => {
    const out = anthropicMessagesToGemini([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('collapses assistant text blocks into model role', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi ', citations: null } as never,
          { type: 'text', text: 'there.', citations: null } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    expect(out).toEqual([{ role: 'model', parts: [{ text: 'Hi there.' }] }]);
  });

  it('converts assistant text + tool_use → model parts with text + functionCall', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Rolling…', citations: null } as never,
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { mod: 3 } } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    expect(out).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'Rolling…' },
          { functionCall: { name: 'roll_d20', args: { mod: 3 } } },
        ],
      },
    ]);
  });

  it('fans out N tool_results into a single user turn with N functionResponse parts', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: {} } as never,
          { type: 'tool_use', id: 'tu2', name: 'apply_damage', input: {} } as never,
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok-1', is_error: false } as never,
          { type: 'tool_result', tool_use_id: 'tu2', content: 'err', is_error: true } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    // 2 entries: model with 2 functionCalls, then user with 2 functionResponse parts
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'roll_d20', response: { content: 'ok-1' } } },
        { functionResponse: { name: 'apply_damage', response: { content: 'err', error: true } } },
      ],
    });
  });

  it('falls back to "unknown" function name when tool_result references an unseen tool_use_id', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'orphan', content: 'r', is_error: false } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    expect(out).toEqual([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'unknown', response: { content: 'r' } } }],
      },
    ]);
  });
});

import {
  geminiResponseToContentBlocks,
  geminiFinishReasonToStopReason,
  normalizeGeminiUsage,
} from '@/ai/provider/gemini-adapter';

describe('gemini-adapter — response + usage', () => {
  it('text-only response → text content block', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [{ content: { role: 'model', parts: [{ text: 'You see a dragon.' }] } }],
    });
    expect(blocks).toEqual([{ type: 'text', text: 'You see a dragon.' }]);
  });

  it('functionCall-only response → tool_use block with synthetic id', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'roll_d20', args: { mod: 5 } } }],
          },
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.type).toBe('tool_use');
    if (b.type === 'tool_use') {
      expect(b.name).toBe('roll_d20');
      expect(b.input).toEqual({ mod: 5 });
      expect(typeof b.id).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
    }
  });

  it('mixed text + functionCall → mixed blocks', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Rolling…' },
              { functionCall: { name: 'roll_d20', args: {} } },
            ],
          },
        },
      ],
    });
    expect(blocks[0]).toEqual({ type: 'text', text: 'Rolling…' });
    expect(blocks[1]?.type).toBe('tool_use');
  });

  it('functionCall with string args → JSON.parse fallback to _raw', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'r', args: '{ not json' as unknown as Record<string, unknown> } }],
          },
        },
      ],
    });
    expect(blocks[0]?.type).toBe('tool_use');
    if (blocks[0]?.type === 'tool_use') expect(blocks[0].input).toEqual({ _raw: '{ not json' });
  });

  it('finishReason mapping covers STOP/MAX_TOKENS/SAFETY/RECITATION', () => {
    expect(geminiFinishReasonToStopReason('STOP', false)).toBe('end_turn');
    expect(geminiFinishReasonToStopReason('STOP', true)).toBe('tool_use');
    expect(geminiFinishReasonToStopReason('MAX_TOKENS', false)).toBe('max_tokens');
    expect(geminiFinishReasonToStopReason('SAFETY', false)).toBe('other');
    expect(geminiFinishReasonToStopReason('RECITATION', false)).toBe('other');
    expect(geminiFinishReasonToStopReason(undefined, false)).toBe('other');
  });

  it('usage normalization with all fields present', () => {
    const out = normalizeGeminiUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 25,
      cachedContentTokenCount: 80,
    });
    expect(out).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  it('usage normalization with missing fields returns zeros', () => {
    expect(normalizeGeminiUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(normalizeGeminiUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
