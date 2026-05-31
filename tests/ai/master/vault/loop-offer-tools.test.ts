import { describe, it, expect, vi } from 'vitest';
import { runVaultToolLoop } from '@/ai/master/vault/loop';
import { VAULT_TOOL_DEFINITIONS } from '@/ai/master/vault/tools';
import type { MasterProvider } from '@/ai/provider/types';

/**
 * Begin-turn fix: on the campaign opener there is nothing to read or mutate —
 * the master just narrates the first scene. But qwen3 (and other local models),
 * when handed the 4 vault tools, reaches for a tool (observed: list_vault) on
 * the opener instead of narrating → empty content → "turn produced empty
 * response" → the UI stalls forever.
 *
 * Root cause is reproduced live: the SAME 4816-char vault system prompt narrates
 * ~800 chars with ZERO tools in the request, but returns empty content + 1
 * tool_call WITH the tools present.
 *
 * Fix: `runVaultToolLoop` gains `offerTools` (default true). When false, it
 * passes `tools: []` to the provider so the model cannot tool-call — used by
 * the route for the begin-turn.
 */

function captureProvider(): { provider: MasterProvider; calls: { toolCount: number }[] } {
  const calls: { toolCount: number }[] = [];
  const provider = {
    completeMessage: vi.fn(async (input: { tools?: unknown[] }) => {
      calls.push({ toolCount: input.tools?.length ?? 0 });
      return {
        contentBlocks: [{ type: 'text', text: 'La scena si apre…' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  } as unknown as MasterProvider;
  return { provider, calls };
}

describe('runVaultToolLoop — offerTools gate (begin-turn empty-response fix)', () => {
  it('offers the full vault tool surface by default', async () => {
    const { provider, calls } = captureProvider();
    await runVaultToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'I attack' }],
    });
    expect(calls[0]!.toolCount).toBe(VAULT_TOOL_DEFINITIONS.length); // 4
  });

  it('offers NO tools when offerTools is false (begin-turn narration-only)', async () => {
    const { provider, calls } = captureProvider();
    const result = await runVaultToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'Inizia la campagna' }],
      offerTools: false,
    });
    expect(calls[0]!.toolCount).toBe(0);
    // …and the narration still comes through.
    expect(result.finalText).toBe('La scena si apre…');
  });
});
