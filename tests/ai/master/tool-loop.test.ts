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

  it('strips a leaked THINK reasoning preamble before emitting narrative_delta', async () => {
    const leaked = [
      'THINK',
      'The player is entering the trapdoor. Need a vivid descent.',
      '',
      'You descend the slick stone steps. The air thickens with salt and kelp.',
    ].join('\n');
    const complete = vi.fn().mockResolvedValueOnce(fakeOutput([{ type: 'text', text: leaked }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'open the trapdoor' }],
      state: baseState,
    });
    expect(result.finalText).toBe(
      'You descend the slick stone steps. The air thickens with salt and kelp.',
    );
    const delta = result.events.find((e) => e.type === 'narrative_delta');
    expect(delta?.type).toBe('narrative_delta');
    if (delta?.type === 'narrative_delta') {
      expect(delta.text).not.toMatch(/THINK/);
      expect(delta.text).toBe(
        'You descend the slick stone steps. The air thickens with salt and kelp.',
      );
    }
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

  describe('requiredToolsBeforeEnd enforcement', () => {
    // We use set_tonal_frame as the canonical required tool because it's the
    // production case (master opener), but the loop treats any name uniformly.

    it('commits buffered events when the required tool was called', async () => {
      const complete = vi.fn()
        .mockResolvedValueOnce(fakeOutput(
          [{ type: 'tool_use', id: 'tu1', name: 'set_tonal_frame', input: { frame: 'sword_sorcery' } }],
          'tool_use',
        ))
        .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'The torches gutter…' }]));

      const onEvent = vi.fn();
      const result = await runToolLoop({
        provider: fakeProvider(complete),
        systemBlocks: [{ type: 'text', text: 'sys' }],
        history: [{ role: 'user', content: 'begin' }],
        state: baseState,
        onEvent,
        requiredToolsBeforeEnd: ['set_tonal_frame'],
      });

      expect(complete).toHaveBeenCalledTimes(2);
      expect(result.finalText).toBe('The torches gutter…');
      // All events that were buffered while inTentative must have been flushed
      // through onEvent. tool_use_start + tool_use_end + narrative_delta all
      // expected once.
      const eventTypes = onEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(eventTypes).toContain('tool_use_start');
      expect(eventTypes).toContain('tool_use_end');
      expect(eventTypes).toContain('narrative_delta');
    });

    it('retries once with corrective user message when required tool missing', async () => {
      const complete = vi.fn()
        // iter 0: model just narrates without calling set_tonal_frame
        .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Bad opening, no tool call.' }]))
        // iter 1 (retry): model now calls the tool
        .mockResolvedValueOnce(fakeOutput(
          [{ type: 'tool_use', id: 'tu1', name: 'set_tonal_frame', input: { frame: 'dark' } }],
          'tool_use',
        ))
        // iter 2: model narrates properly
        .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Good opening, dark frame.' }]));

      const onEvent = vi.fn();
      const result = await runToolLoop({
        provider: fakeProvider(complete),
        systemBlocks: [{ type: 'text', text: 'sys' }],
        history: [{ role: 'user', content: 'begin' }],
        state: baseState,
        onEvent,
        requiredToolsBeforeEnd: ['set_tonal_frame'],
      });

      expect(complete).toHaveBeenCalledTimes(3);
      // finalText reflects ONLY the retry's narration; the failed iter 0
      // narration was discarded.
      expect(result.finalText).toBe('Good opening, dark frame.');
      expect(result.finalText).not.toContain('Bad opening');

      // The discarded iter 0 narrative_delta must never have reached onEvent.
      const deltaTexts = onEvent.mock.calls
        .filter((c) => (c[0] as { type: string }).type === 'narrative_delta')
        .map((c) => (c[0] as { type: string; text: string }).text);
      expect(deltaTexts.join('')).toBe('Good opening, dark frame.');

      // The second provider call must have received the corrective user
      // message. We assert on index [1] (right after the original user msg)
      // rather than .at(-1) because the messages array is captured by
      // reference — iter 1's tool_use + iter 2's tool_result append to it
      // before this assertion runs.
      const iter1Messages = (complete.mock.calls[1]?.[0] as { messages: { role: string; content: unknown }[] }).messages;
      const correctiveMsg = iter1Messages[1];
      expect(correctiveMsg?.role).toBe('user');
      expect(correctiveMsg?.content).toMatch(/Server enforcement.*set_tonal_frame/);
    });

    it('gives up after one retry and commits whatever the model produced', async () => {
      const complete = vi.fn()
        // iter 0: bad
        .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'First attempt, no tool.' }]))
        // iter 1: still bad (model is stubborn)
        .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Second attempt, still no tool.' }]));

      const onEvent = vi.fn();
      const result = await runToolLoop({
        provider: fakeProvider(complete),
        systemBlocks: [{ type: 'text', text: 'sys' }],
        history: [{ role: 'user', content: 'begin' }],
        state: baseState,
        onEvent,
        requiredToolsBeforeEnd: ['set_tonal_frame'],
      });

      // Exactly one retry (so 2 total calls), then commit and exit.
      expect(complete).toHaveBeenCalledTimes(2);
      // The retry's narration is committed (we don't deadlock the user with no opener).
      expect(result.finalText).toBe('Second attempt, still no tool.');
      // The discarded iter 0 narration is gone.
      const deltaTexts = onEvent.mock.calls
        .filter((c) => (c[0] as { type: string }).type === 'narrative_delta')
        .map((c) => (c[0] as { type: string; text: string }).text);
      expect(deltaTexts.join('')).toBe('Second attempt, still no tool.');
    });

    it('does not buffer when requiredToolsBeforeEnd is undefined (non-begin turn)', async () => {
      const complete = vi.fn().mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Just a regular turn.' }]));
      const onEvent = vi.fn();
      await runToolLoop({
        provider: fakeProvider(complete),
        systemBlocks: [{ type: 'text', text: 'sys' }],
        history: [{ role: 'user', content: 'do something' }],
        state: baseState,
        onEvent,
        // requiredToolsBeforeEnd omitted — should flow without any gate.
      });
      // narrative_delta fires immediately via onEvent (no buffering).
      const delta = onEvent.mock.calls.find((c) => (c[0] as { type: string }).type === 'narrative_delta');
      expect(delta).toBeDefined();
      expect(complete).toHaveBeenCalledOnce();
    });
  });
});
