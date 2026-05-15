import { describe, it, expect } from 'vitest';
import {
  anthropicSystemToOllamaMessage,
  anthropicMessagesToOllama,
  anthropicToolToOllama,
  ollamaResponseToContentBlocks,
  ollamaDoneReasonToStopReason,
  normalizeOllamaUsage,
} from '@/ai/provider/ollama-adapter';

describe('anthropicSystemToOllamaMessage', () => {
  it('joins multiple system blocks into one role:system message', () => {
    const r = anthropicSystemToOllamaMessage([
      { type: 'text', text: 'You are a master.' },
      { type: 'text', text: 'Follow rules.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(r).toEqual({ role: 'system', content: 'You are a master.\n\nFollow rules.' });
  });

  it('handles empty system blocks list', () => {
    expect(anthropicSystemToOllamaMessage([])).toBeNull();
  });
});

describe('anthropicMessagesToOllama', () => {
  it('passes through plain user message', () => {
    expect(anthropicMessagesToOllama([{ role: 'user', content: 'hello' }]))
      .toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('handles assistant tool_use block — emits tool_calls', () => {
    const r = anthropicMessagesToOllama([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'rolling now' },
          { type: 'tool_use', id: 'tool_001', name: 'roll_dice', input: { sides: 20 } },
        ],
      },
    ]);
    expect(r).toEqual([{
      role: 'assistant',
      content: 'rolling now',
      tool_calls: [{
        id: 'tool_001',
        type: 'function',
        function: { name: 'roll_dice', arguments: { sides: 20 } },
      }],
    }]);
  });

  it('fans out user tool_result blocks into separate role:tool messages', () => {
    const r = anthropicMessagesToOllama([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_001', content: '{"total":17}' },
          { type: 'tool_result', tool_use_id: 'tool_002', content: '{"total":3}'  },
        ],
      },
    ]);
    expect(r).toEqual([
      { role: 'tool', content: '{"total":17}', tool_call_id: 'tool_001' },
      { role: 'tool', content: '{"total":3}',  tool_call_id: 'tool_002' },
    ]);
  });
});

describe('anthropicToolToOllama', () => {
  it('renames input_schema to parameters', () => {
    const r = anthropicToolToOllama({
      name: 'roll_dice',
      description: 'Roll dice',
      input_schema: { type: 'object', properties: { sides: { type: 'number' } } },
    });
    expect(r).toEqual({
      type: 'function',
      function: {
        name: 'roll_dice',
        description: 'Roll dice',
        parameters: { type: 'object', properties: { sides: { type: 'number' } } },
      },
    });
  });
});

describe('ollamaResponseToContentBlocks', () => {
  it('text-only response → single text block', () => {
    expect(ollamaResponseToContentBlocks({ role: 'assistant', content: 'hello there' }))
      .toEqual([{ type: 'text', text: 'hello there' }]);
  });

  it('response with tool_calls → text + tool_use blocks (synthetic id when missing)', () => {
    const r = ollamaResponseToContentBlocks({
      role: 'assistant',
      content: 'rolling',
      tool_calls: [{ function: { name: 'roll_dice', arguments: { sides: 20 } } }],
    });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ type: 'text', text: 'rolling' });
    expect(r[1]).toMatchObject({
      type: 'tool_use',
      name: 'roll_dice',
      input: { sides: 20 },
    });
    if (r[1]?.type === 'tool_use') expect(r[1].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses provided tool_call id when present', () => {
    const r = ollamaResponseToContentBlocks({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_custom', function: { name: 'x', arguments: {} } }],
    });
    expect(r[0]).toMatchObject({ type: 'tool_use', id: 'tc_custom' });
  });

  it('skips empty text blocks', () => {
    expect(ollamaResponseToContentBlocks({ role: 'assistant', content: '' })).toEqual([]);
  });
});

describe('ollamaDoneReasonToStopReason', () => {
  it('stop → end_turn (no tool_calls)', () => {
    expect(ollamaDoneReasonToStopReason('stop', false)).toBe('end_turn');
  });
  it('stop → tool_use (when has tool_calls)', () => {
    expect(ollamaDoneReasonToStopReason('stop', true)).toBe('tool_use');
  });
  it('length → max_tokens', () => {
    expect(ollamaDoneReasonToStopReason('length', false)).toBe('max_tokens');
  });
  it('other → other', () => {
    expect(ollamaDoneReasonToStopReason('something', false)).toBe('other');
  });
});

describe('normalizeOllamaUsage', () => {
  it('maps eval_count and prompt_eval_count', () => {
    expect(normalizeOllamaUsage({ prompt_eval_count: 123, eval_count: 45 })).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
  it('defaults missing fields to 0', () => {
    expect(normalizeOllamaUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
