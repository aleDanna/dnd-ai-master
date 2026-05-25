import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runVaultToolLoop } from '@/ai/master/vault/loop';
import type {
  MasterProvider,
  CompleteMessageInput,
  CompleteMessageOutput,
  ContentBlock,
  NormalizedUsage,
} from '@/ai/provider/types';

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Make a scripted MasterProvider that returns the queued responses
 * in order. Each call pops the next entry. */
function scriptedProvider(responses: (
  | { contentBlocks: ContentBlock[]; deltas?: string[]; sleepMs?: number }
)[]): MasterProvider {
  let idx = 0;
  return {
    name: 'anthropic',
    async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
      const entry = responses[idx];
      idx += 1;
      if (!entry) throw new Error(`scriptedProvider: no response queued for call #${idx}`);
      if (entry.sleepMs) await new Promise((r) => setTimeout(r, entry.sleepMs));
      if (entry.deltas && input.onDelta) {
        for (const d of entry.deltas) input.onDelta(d);
      }
      return {
        contentBlocks: entry.contentBlocks,
        stopReason: entry.contentBlocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: EMPTY_USAGE,
      };
    },
    async detectLanguage() { return { code: null, usage: EMPTY_USAGE }; },
    async proposeWizard() { return { toolInput: {}, usage: EMPTY_USAGE }; },
  } as unknown as MasterProvider;
}

const BASE_INPUT = {
  systemBlocks: [{ type: 'text' as const, text: 'system' }],
  history: [{ role: 'user' as const, content: 'Hello.' }],
};

describe('runVaultToolLoop — terminators (REQ-013)', () => {
  let root: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-loop-test-'));
    root = join(dir, 'vault');
    await mkdir(join(root, 'handbook'), { recursive: true });
    await writeFile(join(root, 'handbook', 'fireball.md'), 'Fireball deals 8d6.', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  it('terminator 1: end_turn tool call sets finalText and breaks the loop', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'read_vault_multi', input: { paths: ['/handbook/fireball.md'] } },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_2', name: 'end_turn', input: { response: 'Final narrative.' } },
        ],
      },
    ]);
    const result = await runVaultToolLoop({ provider, vaultRoot: root, ...BASE_INPUT });
    expect(result.finalText).toBe('Final narrative.');
    expect(result.toolCallCount).toBe(1);   // only read_vault_multi counts; end_turn is the terminator
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
    const toolStarts = result.events.filter((e) => e.type === 'tool_use_start');
    expect(toolStarts.map((e) => e.type === 'tool_use_start' && e.name)).toEqual(['read_vault_multi', 'end_turn']);
  });

  it('terminator 2: no_tool_calls + content uses streamed text as finalText', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'list_vault', input: { directory: '/handbook' } },
        ],
      },
      {
        contentBlocks: [{ type: 'text', text: 'Here is the answer.' }],
      },
    ]);
    const result = await runVaultToolLoop({ provider, vaultRoot: root, ...BASE_INPUT });
    expect(result.finalText).toBe('Here is the answer.');
    expect(result.toolCallCount).toBe(1);
    const endTurnEvents = result.events.filter((e) => e.type === 'tool_use_start' && e.name === 'end_turn');
    expect(endTurnEvents).toHaveLength(0);
  });
});

describe('runVaultToolLoop — caps + timeouts', () => {
  it('truncates when tool-call cap would be exceeded', async () => {
    // 21 calls (cap = VAULT_TURN_TOOL_CALL_CAP = 20 by default for the vault
    // path, so the 21st overflows and triggers truncation). Phase 02 raised
    // the cap from 12 → 20 to accommodate combat turns with many apply_event
    // mutations (see RESEARCH.md Pitfall 4).
    const responses = Array.from({ length: 21 }, (_, i) => ({
      contentBlocks: [
        { type: 'tool_use' as const, id: `tu_${i}`, name: 'list_vault', input: { directory: '/handbook' } },
      ],
    }));
    const provider = scriptedProvider(responses);
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    expect(result.truncated).toBe(true);
    expect(result.toolCallCount).toBe(20);
    expect(result.events.some((e) => e.type === 'turn_error' && e.reason === 'tool_call_cap')).toBe(true);
  });

  it('times out when wall-clock budget is exceeded', async () => {
    const provider = scriptedProvider([
      // Single call that sleeps 50ms; budget is 10ms → timeout.
      {
        contentBlocks: [{ type: 'tool_use', id: 'tu_1', name: 'list_vault', input: { directory: '/handbook' } }],
      },
      {
        contentBlocks: [{ type: 'tool_use', id: 'tu_2', name: 'list_vault', input: { directory: '/handbook' } }],
        sleepMs: 50,
      },
    ]);
    const result = await runVaultToolLoop({ provider, turnTimeoutMs: 10, ...BASE_INPUT });
    expect(result.timedOut).toBe(true);
    expect(result.events.some((e) => e.type === 'turn_error' && e.reason === 'timeout')).toBe(true);
  });
});

describe('runVaultToolLoop — error paths', () => {
  it('surfaces unknown tool name as tool_use_end ok=false, model gets corrective feedback', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'cast_spell', input: { spell: 'Fireball' } },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_2', name: 'end_turn', input: { response: 'Recovered.' } },
        ],
      },
    ]);
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    expect(result.finalText).toBe('Recovered.');
    const errorEvt = result.events.find((e) => e.type === 'tool_use_end' && !e.ok);
    expect(errorEvt).toBeDefined();
    if (errorEvt && errorEvt.type === 'tool_use_end') {
      expect(errorEvt.error).toContain('unknown vault tool: cast_spell');
    }
  });

  it('traversal attempt is surfaced INLINE within read_vault_multi (per-path error, batch continues)', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'read_vault_multi', input: { paths: ['../etc/passwd'] } },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_2', name: 'end_turn', input: { response: 'Done.' } },
        ],
      },
    ]);
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    // The dispatcher surfaced "ERROR: path outside vault" inline. The
    // tool_use_end event reports ok=true because per-path errors don't
    // fail the batch (spike 009).
    const toolEnd = result.events.find((e) => e.type === 'tool_use_end' && 'toolUseId' in e && e.toolUseId === 'tu_1');
    expect(toolEnd).toBeDefined();
    if (toolEnd && toolEnd.type === 'tool_use_end') {
      expect(toolEnd.ok).toBe(true);
    }
  });
});

describe('runVaultToolLoop — streaming dedup', () => {
  it('streamed deltas + no final text-block → one delta per stream chunk', async () => {
    const provider = scriptedProvider([
      { contentBlocks: [], deltas: ['hello ', 'world'] },
    ]);
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    const deltas = result.events.filter((e) => e.type === 'narrative_delta');
    expect(deltas).toHaveLength(2);
    if (deltas[0]?.type === 'narrative_delta' && deltas[1]?.type === 'narrative_delta') {
      expect(deltas[0].text + deltas[1].text).toBe('hello world');
    }
  });

  it('streamed deltas + final text-block → no re-emission from text block scan', async () => {
    const provider = scriptedProvider([
      {
        deltas: ['streamed '],
        contentBlocks: [{ type: 'text', text: 'streamed text-block content' }],
      },
    ]);
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    // streamedAny is true after the delta fires, so the text-block scan
    // adds to finalText but does NOT re-emit.
    const deltas = result.events.filter((e) => e.type === 'narrative_delta');
    expect(deltas).toHaveLength(1);
  });
});

describe('runVaultToolLoop — engine decoupling sanity', () => {
  it('does NOT emit `state_changed` events (loop is decoupled from engine)', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'end_turn', input: { response: 'Just narrative.' } },
        ],
      },
    ]);
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    expect(result.events.filter((e) => e.type === 'state_changed')).toHaveLength(0);
  });

  it('does not invoke recordUsage when not provided', async () => {
    const provider = scriptedProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_1', name: 'end_turn', input: { response: 'OK' } }] },
    ]);
    // Should not throw without recordUsage.
    const result = await runVaultToolLoop({ provider, ...BASE_INPUT });
    expect(result.finalText).toBe('OK');
  });

  it('invokes recordUsage once per round-trip when provided', async () => {
    let calls = 0;
    const provider = scriptedProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_1', name: 'list_vault', input: { directory: '/handbook' } }] },
      { contentBlocks: [{ type: 'tool_use', id: 'tu_2', name: 'end_turn', input: { response: 'Done' } }] },
    ]);
    await runVaultToolLoop({
      provider,
      ...BASE_INPUT,
      recordUsage: async () => { calls += 1; },
    });
    expect(calls).toBe(2);
  });
});
