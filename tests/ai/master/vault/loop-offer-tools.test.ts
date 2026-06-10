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

// ─── 2026-06-10 live incident: hallucinated tool calls on a NO-TOOLS turn ───
//
// gemma4:12b-mlx, narration-only damage-roll turn (tools=0): 155s of CoT,
// content.len=0, tool_calls=2. The loop DISPATCHED the hallucinated calls
// (a narration-only turn could even mutate events.md) and counted them in
// toolCallCount — which suppressed the empty-narration retry, surfacing
// "il master non ha prodotto risposta" to the player.
// Contract: offerTools:false ⇒ tool calls are NEVER dispatched and NEVER
// counted; a non-empty end_turn.response is still rescued as narration;
// the turn terminates after one provider pass.

describe('runVaultToolLoop — hallucinated tool calls on a no-tools turn', () => {
  it('drops hallucinated tool calls: no dispatch, toolCallCount 0, single provider pass', async () => {
    const completeMessage = vi.fn(async () => ({
      contentBlocks: [
        { type: 'tool_use', id: 't1', name: 'apply_event', input: { type: 'hp_change', payload: { character: 'x', delta: -5 } } },
        { type: 'tool_use', id: 't2', name: 'list_vault', input: { path: '/' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const provider = { completeMessage } as unknown as MasterProvider;
    const result = await runVaultToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).' }],
      offerTools: false,
    });
    expect(completeMessage).toHaveBeenCalledTimes(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('still rescues a non-empty end_turn.response as narration', async () => {
    const completeMessage = vi.fn(async () => ({
      contentBlocks: [
        { type: 'tool_use', id: 't1', name: 'end_turn', input: { response: 'La lama affonda nel fianco del golem.' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const provider = { completeMessage } as unknown as MasterProvider;
    const result = await runVaultToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'guardo' }],
      offerTools: false,
    });
    expect(result.finalText).toBe('La lama affonda nel fianco del golem.');
    expect(result.toolCallCount).toBe(0);
  });
});
