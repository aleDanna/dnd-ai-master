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
