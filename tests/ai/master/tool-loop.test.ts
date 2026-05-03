import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/ai/master/tool-loop';
import type { EngineState } from '@/engine/types';
import type { CompleteMessageOutput, MasterProvider } from '@/ai/provider/types';

const baseState: EngineState = {
  characters: [
    {
      id: 'pc1', name: 'Tharion', level: 1, xp: 0,
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

function fakeOutput(blocks: CompleteMessageOutput['contentBlocks'], stopReason: CompleteMessageOutput['stopReason'] = 'end_turn'): CompleteMessageOutput {
  return {
    contentBlocks: blocks,
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

function fakeProvider(impl: MasterProvider['completeMessage']): MasterProvider {
  return {
    name: 'anthropic',
    completeMessage: impl,
    detectLanguage: vi.fn().mockResolvedValue(null) as unknown as MasterProvider['detectLanguage'],
    proposeWizard: vi.fn().mockRejectedValue(new Error('not used')) as unknown as MasterProvider['proposeWizard'],
  };
}

describe('runToolLoop', () => {
  it('emits a narrative delta and stops when no tool_use', async () => {
    const complete = vi.fn().mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'You see a dragon.' }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'look around' }],
      state: baseState,
    });
    expect(result.finalText).toBe('You see a dragon.');
    expect(result.events.find((e) => e.type === 'narrative_delta')).toBeDefined();
    expect(result.toolCallCount).toBe(0);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('runs a tool, feeds tool_result back, then completes', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput(
        [
          { type: 'text', text: 'Rolling…' },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } },
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'You hit!' }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'attack' }],
      state: baseState,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.finalText).toContain('You hit!');
    expect(result.events.find((e) => e.type === 'tool_use_start')).toBeDefined();
    expect(result.events.find((e) => e.type === 'tool_use_end')).toBeDefined();
  });

  it('stops with truncated=true when cap is exceeded', async () => {
    const looping = fakeOutput([{ type: 'tool_use', id: 'tu', name: 'roll_d20', input: {} }], 'tool_use');
    const complete = vi.fn().mockResolvedValue(looping);
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'spam' }],
      state: baseState,
    });
    expect(result.truncated).toBe(true);
    expect(result.events.some((e) => e.type === 'turn_error' && e.reason === 'tool_call_cap')).toBe(true);
  });

  it('captures unknown_tool cleanly without throwing', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput([{ type: 'tool_use', id: 'tu1', name: 'fly_to_moon', input: {} }], 'tool_use'))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Adapting…' }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
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
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput(
        [
          { type: 'text', text: 'Rolling…' },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } },
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Done.' }]));
    const seen: string[] = [];
    const result = await runToolLoop({
      provider: fakeProvider(complete),
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

  it('keeps the turn alive when applyMutations rejects (DB blip / connection drop)', async () => {
    // Master rolls a d20 — the roll itself succeeds, but the persistence
    // step (applyMutations) throws. Before this fix, the throw bubbled up
    // out of the tool loop, the route's outer catch fired turn_error, and
    // the master's narration was never persisted. Now the failure is
    // surfaced as a tool error so the master sees it and can keep going.
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput(
        [{ type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 0 } }],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Sorry, the dice slipped.' }]));
    const apply = vi.fn().mockRejectedValue(new Error('Failed query: connection terminated'));

    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'roll' }],
      state: baseState,
      applyMutations: apply,
    });

    expect(apply).toHaveBeenCalledOnce();
    // Loop should have completed and the master got to narrate.
    expect(result.finalText).toContain('Sorry, the dice slipped.');
    // No state_changed event because the persist failed.
    expect(result.events.some((e) => e.type === 'state_changed')).toBe(false);
    // The tool_result fed back to the model carries the persistence error.
    const lastUserMsg = (complete.mock.calls.at(-1)?.[0] as { messages: { role: string; content: unknown }[] }).messages.at(-1);
    expect(lastUserMsg?.role).toBe('user');
    const toolResult = (lastUserMsg!.content as { type: string; content: string; is_error: boolean }[])[0]!;
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/persistence_failed/);
  });
});
