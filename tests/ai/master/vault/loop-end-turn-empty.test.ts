import { describe, it, expect, vi } from 'vitest';
import { runVaultToolLoop } from '@/ai/master/vault/loop';
import type { MasterProvider } from '@/ai/provider/types';

/**
 * 2026-06-10 audit — end_turn with a missing/non-string `response` (a common
 * weak-model shape: `end_turn{}`) used to OVERWRITE the narration accumulated
 * in earlier iterations: the dispatcher normalizes a missing response to '',
 * and `finalText = result.endTurnResponse ?? finalText` treats '' as present.
 * The player saw the streamed text vanish on persistence (or the route
 * triggered the empty-narration retry, compounding into double-apply risk).
 *
 * Contract: a non-empty end_turn response wins; an empty/missing one
 * preserves the accumulated narration.
 */

function providerReturning(blocks: unknown[]): MasterProvider {
  return {
    completeMessage: vi.fn(async () => ({
      contentBlocks: blocks,
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  } as unknown as MasterProvider;
}

describe('runVaultToolLoop — end_turn empty-response guard', () => {
  it('end_turn{} (no response) preserves the accumulated narration', async () => {
    const provider = providerReturning([
      { type: 'text', text: 'Una scena ricca di dettagli.' },
      { type: 'tool_use', id: 't1', name: 'end_turn', input: {} },
    ]);
    const result = await runVaultToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'guardo' }],
    });
    expect(result.finalText).toBe('Una scena ricca di dettagli.');
  });

  it('end_turn with a real response still wins over accumulated text', async () => {
    const provider = providerReturning([
      { type: 'text', text: 'Bozza parziale.' },
      { type: 'tool_use', id: 't1', name: 'end_turn', input: { response: 'La narrazione definitiva.' } },
    ]);
    const result = await runVaultToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'guardo' }],
    });
    expect(result.finalText).toBe('La narrazione definitiva.');
  });
});
