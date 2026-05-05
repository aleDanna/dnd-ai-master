import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/ai/master/tool-loop';
import type { CompleteMessageOutput, MasterProvider } from '@/ai/provider/types';
import type { EngineState } from '@/engine/types';

function fakeOutput(
  blocks: CompleteMessageOutput['contentBlocks'],
  stopReason: CompleteMessageOutput['stopReason'] = 'end_turn',
): CompleteMessageOutput {
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

describe('runToolLoop DB-aware dispatch', () => {
  it('dispatches a TOOL_HANDLERS_DB tool when called with sessionId', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(
        fakeOutput(
          [{ type: 'tool_use', id: 't1', name: 'lookup_codex', input: { kind: 'npc', query: 'x' } }],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'ok' }]));

    const state = {
      characters: [],
      combatActors: [],
      runtime: {},
      combat: null,
      scene: '',
    } as unknown as EngineState;

    const r = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 's' }],
      history: [{ role: 'user', content: 'hi' }],
      state,
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.toolCallCount).toBe(1);
    // The DB handler is real but the session has no codex rows -> empty matches; still ok=true.
    const toolEnd = r.events.find((e) => e.type === 'tool_use_end');
    expect(toolEnd && 'ok' in toolEnd && toolEnd.ok).toBe(true);
  });
});
