import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/ai/master/tool-loop';
import type { EngineState } from '@/engine/types';
import type Anthropic from '@anthropic-ai/sdk';

const baseState: EngineState = {
  characters: [
    {
      id: 'pc1', name: 'Tharion', level: 1,
      classSlug: 'fighter', raceSlug: 'half-elf', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    },
  ],
  combatActors: [],
  runtime: { pc1: { actorId: 'pc1', hpCurrent: 12, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] } },
  combat: null,
  scene: 'forest clearing',
};

function fakeMessage(content: Anthropic.Messages.ContentBlock[], stop: Anthropic.Messages.Message['stop_reason'] = 'end_turn'): Anthropic.Messages.Message {
  return {
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    container: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never,
  };
}

describe('runToolLoop', () => {
  it('emits a narrative delta and stops when no tool_use', async () => {
    const create = vi.fn().mockResolvedValueOnce(fakeMessage([{ type: 'text', text: 'You see a dragon.', citations: null }]));
    const result = await runToolLoop({
      client: { messages: { create } as never },
      model: 'test',
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'look around' }],
      state: baseState,
    });
    expect(result.finalText).toBe('You see a dragon.');
    expect(result.events.find((e) => e.type === 'narrative_delta')).toBeDefined();
    expect(result.toolCallCount).toBe(0);
    expect(create).toHaveBeenCalledOnce();
  });

  it('runs a tool, feeds tool_result back, then completes', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(fakeMessage(
        [
          { type: 'text', text: 'Rolling…', citations: null },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } } as never,
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeMessage([{ type: 'text', text: 'You hit!', citations: null }]));
    const result = await runToolLoop({
      client: { messages: { create } as never },
      model: 'test',
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'attack' }],
      state: baseState,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.finalText).toContain('You hit!');
    expect(result.events.find((e) => e.type === 'tool_use_start')).toBeDefined();
    expect(result.events.find((e) => e.type === 'tool_use_end')).toBeDefined();
  });

  it('stops with truncated=true when cap is exceeded', async () => {
    const looping = fakeMessage(
      [{ type: 'tool_use', id: 'tu', name: 'roll_d20', input: {} } as never],
      'tool_use',
    );
    const create = vi.fn().mockResolvedValue(looping);
    const result = await runToolLoop({
      client: { messages: { create } as never },
      model: 'test',
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'spam' }],
      state: baseState,
    });
    expect(result.truncated).toBe(true);
    expect(result.events.some((e) => e.type === 'turn_error' && e.reason === 'tool_call_cap')).toBe(true);
  });

  it('captures unknown_tool cleanly without throwing', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(fakeMessage(
        [{ type: 'tool_use', id: 'tu1', name: 'fly_to_moon', input: {} } as never],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeMessage([{ type: 'text', text: 'Adapting…', citations: null }]));
    const result = await runToolLoop({
      client: { messages: { create } as never },
      model: 'test',
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'go' }],
      state: baseState,
    });
    const end = result.events.find((e) => e.type === 'tool_use_end');
    expect(end?.type).toBe('tool_use_end');
    if (end?.type === 'tool_use_end') {
      expect(end.ok).toBe(false);
      expect(end.error).toMatch(/unknown_tool/);
    }
  });

  it('calls onEvent in order as each event is emitted', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(fakeMessage(
        [
          { type: 'text', text: 'Rolling…', citations: null },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } } as never,
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeMessage([{ type: 'text', text: 'Done.', citations: null }]));
    const seen: string[] = [];
    const result = await runToolLoop({
      client: { messages: { create } as never },
      model: 'test',
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'go' }],
      state: baseState,
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen.length).toBe(result.events.length);
    expect(seen).toEqual(result.events.map((e) => e.type));
    expect(seen[0]).toBe('narrative_delta');
    expect(seen.includes('tool_use_start')).toBe(true);
    expect(seen.includes('tool_use_end')).toBe(true);
    expect(seen.at(-1)).toBe('narrative_delta');
  });
});
