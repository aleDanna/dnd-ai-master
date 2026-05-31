import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runVaultToolLoop } from '@/ai/master/vault/loop';
import type { VaultLoopInput } from '@/ai/master/vault/loop';
import type { MasterProvider, CompleteMessageOutput } from '@/ai/provider/types';

/**
 * Option C fallback — inline-event recovery in the vault tool loop.
 *
 * Local models (qwen3:30b-a3b) frequently DESCRIBE combat by writing the event
 * markers as **markdown text** in their narration and make ZERO structured tool
 * calls, so combat never applies and the tracker never opens (live-confirmed on
 * The Goblin Warren). The loop's Terminator-1 (no_tool_calls + content) branch
 * now runs `parseInlineEvents` over the final text and, when combat-event
 * markers are present AND mutations are enabled this turn, dispatches them
 * through the normal `apply_event` path and shows the player the cleaned text.
 *
 * Gates asserted here:
 *  - fires only when campaignId is set AND tools were offered AND
 *    suppressCombatMutations is falsy;
 *  - does NOT fire on the begin/narration-only turn (offerTools:false);
 *  - does NOT fire on a server-resolved combat turn (suppressCombatMutations);
 *  - leaves plain narration untouched.
 */

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock('@/ai/master/vault/tools', async (orig) => {
  const actual = await orig<typeof import('@/ai/master/vault/tools')>();
  return { ...actual, dispatchVaultTool: dispatchMock };
});

vi.mock('@/ai/master/vault/condense', () => ({
  maybeCondense: vi.fn(async (messages: unknown) => ({
    history: messages,
    condensed: false,
    tokensBefore: 0,
    tokensAfter: 0,
  })),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
}));

function makeProvider(outputs: CompleteMessageOutput[]): MasterProvider {
  let call = 0;
  return {
    name: 'mock',
    async completeMessage() {
      const out = outputs[call] ?? outputs[outputs.length - 1]!;
      call += 1;
      return out;
    },
  } as unknown as MasterProvider;
}

function textOutput(text: string): CompleteMessageOutput {
  return {
    contentBlocks: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as unknown as CompleteMessageOutput;
}

// The real leaked-combat narration observed live on The Goblin Warren.
const LEAKED_COMBAT = [
  'Ti lanci in avanti con un grido.',
  '',
  '**combat_start**  ',
  '**monster_spawn** {id: "mutant-1", name: "Ombra del Mulino", hpMax: 24, ac: 13, initiativeBonus: 2, cr: 1}  ',
  '**initiative_set** {order: [{actorId: "302099dd-1572-44b7-8f1a-99b7a9ed39f7", initiative: 12}, {actorId: "mutant-1", initiative: 14}]}  ',
  '',
  'Il mostro si muove per primo.',
  '',
  '**turn_advance**  ',
  '',
  'La lama ti sfiora il braccio. Che fai?',
].join('\n');

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ content: '{"ok":true}', isError: false });
});

describe('runVaultToolLoop — inline-event fallback (Option C)', () => {
  it('recovers leaked combat events from text and dispatches them as apply_event', async () => {
    const provider = makeProvider([textOutput(LEAKED_COMBAT)]);
    await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'attacco' }],
      campaignId: 'camp-1',
    } as unknown as VaultLoopInput);

    // 4 encounter events: combat_start, monster_spawn, initiative_set, turn_advance.
    expect(dispatchMock).toHaveBeenCalledTimes(4);
    const types = dispatchMock.mock.calls.map(
      (c) => (c[1] as { type: string }).type,
    );
    expect(types).toEqual([
      'combat_start',
      'monster_spawn',
      'initiative_set',
      'turn_advance',
    ]);
    // Every dispatch is an apply_event with the campaign context.
    for (const call of dispatchMock.mock.calls) {
      expect(call[0]).toBe('apply_event');
      expect(call[2]).toEqual(expect.objectContaining({ campaignId: 'camp-1' }));
    }
    // monster_spawn payload preserved with correct types.
    const spawn = dispatchMock.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'monster_spawn',
    )!;
    const spawnPayload = (spawn[1] as { payload: Record<string, unknown> }).payload;
    expect(spawnPayload.id).toBe('mutant-1');
    expect(spawnPayload.hpMax).toBe(24);
    expect(spawnPayload.cr).toBe(1);
  });

  it('returns the cleaned narration (markers stripped, prose intact)', async () => {
    const provider = makeProvider([textOutput(LEAKED_COMBAT)]);
    const res = await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'attacco' }],
      campaignId: 'camp-1',
    } as unknown as VaultLoopInput);
    expect(res.finalText).toContain('Ti lanci in avanti con un grido.');
    expect(res.finalText).toContain('Il mostro si muove per primo.');
    expect(res.finalText).toContain('La lama ti sfiora il braccio. Che fai?');
    expect(res.finalText).not.toContain('**');
    expect(res.finalText).not.toContain('monster_spawn');
    expect(res.finalText).not.toContain('{');
  });

  it('emits tool_use_start/end events for each recovered event', async () => {
    const events: { type: string; name?: string }[] = [];
    const provider = makeProvider([textOutput(LEAKED_COMBAT)]);
    await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'attacco' }],
      campaignId: 'camp-1',
      onEvent: (e: { type: string; name?: string }) => events.push(e),
    } as unknown as VaultLoopInput);
    const starts = events.filter((e) => e.type === 'tool_use_start');
    const ends = events.filter((e) => e.type === 'tool_use_end');
    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);
    expect(starts.every((e) => e.name === 'apply_event')).toBe(true);
  });

  it('does NOT recover events when campaignId is absent (read-only flow)', async () => {
    const provider = makeProvider([textOutput(LEAKED_COMBAT)]);
    const res = await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'attacco' }],
      // no campaignId
    } as unknown as VaultLoopInput);
    expect(dispatchMock).not.toHaveBeenCalled();
    // Text is returned unchanged (still carries the markers — nothing to apply).
    expect(res.finalText).toContain('**combat_start**');
  });

  it('does NOT recover events on the narration-only begin turn (offerTools:false)', async () => {
    const provider = makeProvider([textOutput(LEAKED_COMBAT)]);
    await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'begin' }],
      campaignId: 'camp-1',
      offerTools: false,
    } as unknown as VaultLoopInput);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT recover events on a server-resolved combat turn (suppressCombatMutations)', async () => {
    const provider = makeProvider([textOutput(LEAKED_COMBAT)]);
    await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'attacco' }],
      campaignId: 'camp-1',
      suppressCombatMutations: true,
    } as unknown as VaultLoopInput);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('leaves plain narration (no markers) completely untouched', async () => {
    const provider = makeProvider([textOutput('Il taverniere ti sorride. Che fai?')]);
    const res = await runVaultToolLoop({
      provider,
      systemBlocks: [],
      history: [{ role: 'user', content: 'guardo' }],
      campaignId: 'camp-1',
    } as unknown as VaultLoopInput);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(res.finalText).toBe('Il taverniere ti sorride. Che fai?');
  });
});
