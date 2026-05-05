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
