import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

/* -------------------------------------------------------------------------- *
 *  Phase 02 — apply_event integration in the loop (Task 6 of plan 02-07).    *
 *                                                                            *
 *  These tests confirm that runVaultToolLoop's `campaignId` field is         *
 *  threaded into dispatchVaultTool's ctx and that the apply_event tool       *
 *  participates in the loop the same way the Phase 01 tools do (cap         *
 *  accounting, error surface, terminator handling).                          *
 * -------------------------------------------------------------------------- */

const APPLY_CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const APPLY_CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function seedCampaignFile(campaignsRoot: string): Promise<string> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', campaignsRoot);
  vi.resetModules();
  const { dispatchVaultTool } = await import('@/ai/master/vault/tools');
  const { eventsPath } = await import('@/ai/master/vault/campaign-paths');
  const seed = await dispatchVaultTool(
    'apply_event',
    {
      type: 'campaign_initialized',
      payload: {
        characters: [
          { id: APPLY_CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
        ],
      },
    },
    { campaignId: APPLY_CAMPAIGN_UUID },
  );
  if (seed.isError) {
    throw new Error('seed failed: ' + seed.content);
  }
  return eventsPath(APPLY_CAMPAIGN_UUID);
}

describe('runVaultToolLoop — apply_event integration (Phase 02)', () => {
  let campaignsRoot: string;
  let eventsFile: string;
  // Loop must be re-imported AFTER the env stub so transitive references to
  // the (re-evaluated) tools module pick up the new VAULT_CAMPAIGNS_ROOT.
  let loop: typeof import('@/ai/master/vault/loop').runVaultToolLoop;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-loop-apply-event-'));
    eventsFile = await seedCampaignFile(campaignsRoot);
    loop = (await import('@/ai/master/vault/loop')).runVaultToolLoop;
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('forwards campaignId from VaultLoopInput to dispatchVaultTool ctx (events.md gains a line)', async () => {
    const linesBefore = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_apply',
            name: 'apply_event',
            input: { type: 'hp_change', payload: { character: APPLY_CHAR_UUID, delta: -5 } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Took 5 damage.' } },
        ],
      },
    ]);
    const result = await loop({
      provider,
      campaignId: APPLY_CAMPAIGN_UUID,
      ...BASE_INPUT,
    });
    expect(result.finalText).toBe('Took 5 damage.');
    const linesAfter = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    expect(linesAfter).toBe(linesBefore + 1);
  });

  it('apply_event tool result is surfaced as a regular tool_result (not end_turn)', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_apply',
            name: 'apply_event',
            input: { type: 'hp_change', payload: { character: APPLY_CHAR_UUID, delta: -2 } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Done.' } },
        ],
      },
    ]);
    const result = await loop({
      provider,
      campaignId: APPLY_CAMPAIGN_UUID,
      ...BASE_INPUT,
    });
    // Loop should have run 2 rounds (apply_event + end_turn). The final text
    // comes from end_turn, NOT from the apply_event JSON return.
    expect(result.finalText).toBe('Done.');
    expect(result.toolCallCount).toBe(1); // end_turn does not count
    const applyStart = result.events.find(
      (e) => e.type === 'tool_use_start' && 'name' in e && e.name === 'apply_event',
    );
    expect(applyStart).toBeDefined();
    const applyEnd = result.events.find(
      (e) => e.type === 'tool_use_end' && 'toolUseId' in e && e.toolUseId === 'tu_apply',
    );
    expect(applyEnd).toBeDefined();
    if (applyEnd && applyEnd.type === 'tool_use_end') {
      expect(applyEnd.ok).toBe(true);
    }
  });

  it('apply_event failure (malformed payload) surfaces as isError tool_result; loop continues to end_turn', async () => {
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_bad',
            name: 'apply_event',
            // delta is a string — validateEvent rejects.
            input: { type: 'hp_change', payload: { character: APPLY_CHAR_UUID, delta: 'five' } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Recovered.' } },
        ],
      },
    ]);
    const result = await loop({
      provider,
      campaignId: APPLY_CAMPAIGN_UUID,
      ...BASE_INPUT,
    });
    expect(result.finalText).toBe('Recovered.');
    const errorEvt = result.events.find(
      (e) => e.type === 'tool_use_end' && 'toolUseId' in e && e.toolUseId === 'tu_bad',
    );
    expect(errorEvt).toBeDefined();
    if (errorEvt && errorEvt.type === 'tool_use_end') {
      expect(errorEvt.ok).toBe(false);
      expect(errorEvt.error).toMatch(/hp_change/);
    }
  });

  it('omitting campaignId in loop input → apply_event returns isError; events.md unchanged', async () => {
    const linesBefore = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_apply',
            name: 'apply_event',
            input: { type: 'hp_change', payload: { character: APPLY_CHAR_UUID, delta: -5 } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'No campaign.' } },
        ],
      },
    ]);
    // NOTE: NO campaignId passed.
    const result = await loop({ provider, ...BASE_INPUT });
    expect(result.finalText).toBe('No campaign.');
    const errorEvt = result.events.find(
      (e) => e.type === 'tool_use_end' && 'toolUseId' in e && e.toolUseId === 'tu_apply',
    );
    expect(errorEvt).toBeDefined();
    if (errorEvt && errorEvt.type === 'tool_use_end') {
      expect(errorEvt.ok).toBe(false);
      expect(errorEvt.error).toMatch(/campaignId/);
    }
    // No write occurred — events.md still has just the seed line.
    expect(existsSync(eventsFile)).toBe(true);
    const linesAfter = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    expect(linesAfter).toBe(linesBefore);
  });
});
