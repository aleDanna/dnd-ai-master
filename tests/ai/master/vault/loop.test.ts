import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Phase 03-B — mock `@/db/client` BEFORE importing the loop. The loop's new
// `summaryBlock` restore path issues `db.select(...).from(...).where(...).limit(...)`
// and the (transitive) `maybeCondense` issues `db.update(...).set(...).where(...)`.
// The mock supports BOTH chains with controllable return values so each test
// can stage a different scenario (no row, row with summaryBlock, etc.).
//
// `vi.hoisted` is required because the mock factory below is hoisted to the
// top of the file by vitest — references to outer-scope variables would error
// with "Cannot access X before initialization" otherwise. The hoisted block
// runs BEFORE the factory and exposes the shared mock fns.
// ---------------------------------------------------------------------------
const { dbSelectMock, dbUpdateMock } = vi.hoisted(() => {
  return {
    dbSelectMock: vi.fn<() => Array<{ summaryBlock: { text: string; generatedAt: string; tokensBefore: number } | null } | undefined>>(() => []),
    dbUpdateMock: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  };
});

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => dbSelectMock()),
        })),
      })),
    })),
    update: dbUpdateMock,
  },
  pool: {},
  createListenClient: () => {
    throw new Error('not used in loop tests');
  },
}));

import { runVaultToolLoop } from '@/ai/master/vault/loop';
import type {
  MasterProvider,
  CompleteMessageInput,
  CompleteMessageOutput,
  ContentBlock,
  Message,
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

/* -------------------------------------------------------------------------- *
 *  Phase 08 — narration-only mode (plan 08-02, D-06 / RESEARCH Pattern 2).    *
 *                                                                            *
 *  On a server-resolved combat turn the route emits the authoritative        *
 *  encounter events itself (via resolveCombat), then runs the loop in         *
 *  NARRATION-ONLY mode so the LLM colors the outcome WITHOUT re-applying it.  *
 *  `suppressCombatMutations: true` drops the LLM's `apply_event` calls whose  *
 *  type is in ENCOUNTER_EVENT_TYPES (combat_start, monster_spawn,             *
 *  initiative_set, turn_advance, monster_hp_change, combat_end) at the        *
 *  dispatch seam — preventing the Pitfall 3 double-apply. NON-combat          *
 *  apply_event calls (e.g. hp_change) MUST still dispatch.                    *
 *                                                                            *
 *  Reuses the same `scriptedProvider` + tmpfs `VAULT_CAMPAIGNS_ROOT` harness  *
 *  as the Phase 02 apply_event tests, asserting on the events.md line count   *
 *  before/after (the drop = zero new lines; the dispatch = one new line).     *
 * -------------------------------------------------------------------------- */

const NARRATION_CAMPAIGN_UUID = '99999999-8888-7777-6666-555555555555';
const NARRATION_CHAR_UUID = 'cccccccc-dddd-eeee-ffff-000000000000';
const NARRATION_MONSTER_ID = 'monster-veyra-1';

/** Seed a campaign with an active encounter (one monster spawned) AND a
 *  character, so the narration-only tests can drive both a combat-event
 *  apply_event (monster_hp_change → dropped under the flag) and a non-combat
 *  apply_event (hp_change → still dispatched). Returns the events.md path. */
async function seedEncounterCampaign(campaignsRoot: string): Promise<string> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', campaignsRoot);
  vi.resetModules();
  const { dispatchVaultTool } = await import('@/ai/master/vault/tools');
  const { eventsPath } = await import('@/ai/master/vault/campaign-paths');
  const seedEvents: { type: string; payload: Record<string, unknown> }[] = [
    {
      type: 'campaign_initialized',
      payload: {
        characters: [
          { id: NARRATION_CHAR_UUID, name: 'Rufy', hp_max: 40, hp_current: 40 },
        ],
      },
    },
    { type: 'combat_start', payload: {} },
    {
      type: 'monster_spawn',
      payload: { id: NARRATION_MONSTER_ID, name: 'Veyra', hpMax: 18, ac: 14 },
    },
  ];
  for (const ev of seedEvents) {
    const r = await dispatchVaultTool('apply_event', ev, { campaignId: NARRATION_CAMPAIGN_UUID });
    if (r.isError) throw new Error('encounter seed failed: ' + r.content);
  }
  return eventsPath(NARRATION_CAMPAIGN_UUID);
}

describe('runVaultToolLoop — narration-only mode (Phase 08)', () => {
  let campaignsRoot: string;
  let eventsFile: string;
  let loop: typeof import('@/ai/master/vault/loop').runVaultToolLoop;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-loop-narration-'));
    eventsFile = await seedEncounterCampaign(campaignsRoot);
    loop = (await import('@/ai/master/vault/loop')).runVaultToolLoop;
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('(a) suppressCombatMutations:true DROPS a monster_hp_change apply_event (zero new lines) yet completes the turn', async () => {
    const linesBefore = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_combat',
            name: 'apply_event',
            input: { type: 'monster_hp_change', payload: { id: NARRATION_MONSTER_ID, delta: -9 } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Veyra barcolla.' } },
        ],
      },
    ]);
    const result = await loop({
      provider,
      campaignId: NARRATION_CAMPAIGN_UUID,
      suppressCombatMutations: true,
      ...BASE_INPUT,
    });
    expect(result.finalText).toBe('Veyra barcolla.');
    // The drop happens at the loop seam — events.md is untouched.
    const linesAfter = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    expect(linesAfter).toBe(linesBefore);
    // The turn still completes: the dropped call emitted a tool_use_end ok:true.
    const droppedEnd = result.events.find(
      (e) => e.type === 'tool_use_end' && 'toolUseId' in e && e.toolUseId === 'tu_combat',
    );
    expect(droppedEnd).toBeDefined();
    if (droppedEnd && droppedEnd.type === 'tool_use_end') {
      expect(droppedEnd.ok).toBe(true);
    }
  });

  it('(b) regression: flag falsy DISPATCHES the same monster_hp_change (one new line) — Phase 07 behavior', async () => {
    const linesBefore = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_combat',
            name: 'apply_event',
            input: { type: 'monster_hp_change', payload: { id: NARRATION_MONSTER_ID, delta: -9 } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Colpito.' } },
        ],
      },
    ]);
    // NOTE: suppressCombatMutations omitted (falsy) — today's behavior.
    const result = await loop({
      provider,
      campaignId: NARRATION_CAMPAIGN_UUID,
      ...BASE_INPUT,
    });
    expect(result.finalText).toBe('Colpito.');
    const linesAfter = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    expect(linesAfter).toBe(linesBefore + 1);
  });

  it('(c) flag true STILL dispatches a NON-combat apply_event (hp_change) — drop scoped to ENCOUNTER_EVENT_TYPES', async () => {
    const linesBefore = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    const provider = scriptedProvider([
      {
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_hp',
            name: 'apply_event',
            input: { type: 'hp_change', payload: { character: NARRATION_CHAR_UUID, delta: -3 } },
          },
        ],
      },
      {
        contentBlocks: [
          { type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Rufy ferito.' } },
        ],
      },
    ]);
    const result = await loop({
      provider,
      campaignId: NARRATION_CAMPAIGN_UUID,
      suppressCombatMutations: true,
      ...BASE_INPUT,
    });
    expect(result.finalText).toBe('Rufy ferito.');
    // hp_change is NOT an encounter event → it must still dispatch + persist.
    const linesAfter = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
    expect(linesAfter).toBe(linesBefore + 1);
    const hpEnd = result.events.find(
      (e) => e.type === 'tool_use_end' && 'toolUseId' in e && e.toolUseId === 'tu_hp',
    );
    expect(hpEnd).toBeDefined();
    if (hpEnd && hpEnd.type === 'tool_use_end') {
      expect(hpEnd.ok).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- *
 *  Phase 03-B — REQ-023 per-turn summarization (plan 03-B-05).               *
 *                                                                            *
 *  These tests exercise the two wiring changes added to runVaultToolLoop:    *
 *   1. On loop entry, `session_state.summaryBlock` is read and (if present)  *
 *      injected as a `[Riassunto dei turni precedenti]` user message right   *
 *      after the anchor — Pitfall 4 restart-restore.                         *
 *   2. Before each `provider.completeMessage`, `maybeCondense` is invoked    *
 *      when `sessionId && model` are both present. When it returns           *
 *      `condensed:true`, the loop emits a `summarized` event with the        *
 *      tokensBefore/tokensAfter pair.                                        *
 *                                                                            *
 *  The Phase 02 / Phase 01 cases above pass `BASE_INPUT` WITHOUT `sessionId` *
 *  and WITHOUT `model`, so they hit the early-return branches and observe   *
 *  zero summarizer behavior — that's the regression guarantee.               *
 * -------------------------------------------------------------------------- */

const SUMM_SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUMM_MODEL = 'qwen3:30b-a3b-instruct-2507';

/** Inspectable provider — `completeMessage` is a `vi.fn` so test bodies can
 *  introspect call args (especially `messages` on the first call to assert
 *  the restored summary block reached the model). Responses are queued
 *  identically to `scriptedProvider`. */
function inspectableProvider(responses: (
  | { contentBlocks: ContentBlock[]; deltas?: string[]; sleepMs?: number }
)[]): MasterProvider {
  let idx = 0;
  const completeMessage = vi.fn(async (input: CompleteMessageInput): Promise<CompleteMessageOutput> => {
    const entry = responses[idx];
    idx += 1;
    if (!entry) throw new Error(`inspectableProvider: no response queued for call #${idx}`);
    if (entry.sleepMs) await new Promise((r) => setTimeout(r, entry.sleepMs));
    if (entry.deltas && input.onDelta) {
      for (const d of entry.deltas) input.onDelta(d);
    }
    return {
      contentBlocks: entry.contentBlocks,
      stopReason: entry.contentBlocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: EMPTY_USAGE,
    };
  });
  return {
    name: 'anthropic',
    completeMessage,
    async detectLanguage() { return { code: null, usage: EMPTY_USAGE }; },
    async proposeWizard() { return { toolInput: {}, usage: EMPTY_USAGE }; },
  } as unknown as MasterProvider;
}

/** History long enough to cross the default 15K-token trigger.
 *  ~20 messages of 3500 chars = 70K chars / 4 ≈ 17.5K tokens. */
function largeHistoryAboveDefaultThreshold(): Message[] {
  return [
    { role: 'user', content: 'Inizio campagna.' },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: 'x'.repeat(3500),
    })),
  ];
}

/** Compact history that stays well below the default 15K trigger. */
function smallHistory(): Message[] {
  return [
    { role: 'user', content: 'Hello.' },
    { role: 'assistant', content: 'Hi.' },
  ];
}

describe('runVaultToolLoop — REQ-023 per-turn summarization', () => {
  beforeEach(() => {
    dbSelectMock.mockReset();
    dbSelectMock.mockReturnValue([]); // default: no persisted summaryBlock
    dbUpdateMock.mockClear();
    vi.unstubAllEnvs();
    // Default ON so condense's kill-switch reads `true`. Individual tests
    // re-stub to 'off' or different thresholds as needed.
    vi.stubEnv('MASTER_SUMMARIZATION', 'on');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-op below threshold: no summarized event, no condense fire, no DB update', async () => {
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'OK' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: smallHistory(),
    });
    expect(result.finalText).toBe('OK');
    expect(result.events.filter((e) => e.type === 'summarized')).toHaveLength(0);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('fires above threshold: emits summarized event with tokensBefore/tokensAfter and persists', async () => {
    // Force the threshold low so a 1-call setup easily triggers.
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '1000');
    const provider = inspectableProvider([
      // Call 1: the summarizer's request — model returns a short summary text.
      { contentBlocks: [{ type: 'text', text: 'Riassunto: i pirati sbarcano.' }] },
      // Call 2: the actual turn — model immediately ends.
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Done.' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: largeHistoryAboveDefaultThreshold(),
    });
    expect(result.finalText).toBe('Done.');
    const summEvents = result.events.filter((e) => e.type === 'summarized');
    expect(summEvents).toHaveLength(1);
    if (summEvents[0]?.type === 'summarized') {
      expect(summEvents[0].tokensBefore).toBeGreaterThan(summEvents[0].tokensAfter);
      expect(summEvents[0].tokensBefore).toBeGreaterThan(1000);
    }
    // Persistence fired exactly once during this turn.
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('restores existing summaryBlock on entry: provider sees the [Riassunto] block in messages[1]', async () => {
    // Prepopulate the DB read: the session_state row already carries a
    // summary text from a previous turn (the "restart" scenario).
    const prevSummary = 'Sintesi precedente: il gruppo ha sconfitto il drago.';
    dbSelectMock.mockReturnValue([
      { summaryBlock: { text: prevSummary, generatedAt: '2026-05-27T10:00:00.000Z', tokensBefore: 18000 } },
    ]);
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Riprendiamo.' } }] },
    ]);
    await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: smallHistory(),
    });
    // First call to the model — assert the messages array carries the
    // injected summary at index 1 (right after the anchor).
    const completeMessage = provider.completeMessage as ReturnType<typeof vi.fn>;
    expect(completeMessage).toHaveBeenCalledTimes(1);
    const firstInput = completeMessage.mock.calls[0]![0] as CompleteMessageInput;
    expect(firstInput.messages).toHaveLength(3); // anchor + summary + assistant reply
    expect(firstInput.messages[1]!.role).toBe('user');
    expect(firstInput.messages[1]!.content as string).toContain('[Riassunto dei turni precedenti]');
    expect(firstInput.messages[1]!.content as string).toContain(prevSummary);
  });

  it('MASTER_SUMMARIZATION=off: kill-switch suppresses summarizer regardless of size', async () => {
    vi.stubEnv('MASTER_SUMMARIZATION', 'off');
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Off mode.' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: largeHistoryAboveDefaultThreshold(),
    });
    expect(result.finalText).toBe('Off mode.');
    expect(result.events.filter((e) => e.type === 'summarized')).toHaveLength(0);
    expect(dbUpdateMock).not.toHaveBeenCalled();
    // The provider was called exactly once — no summarizer round-trip.
    expect((provider.completeMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('sessionId undefined: skips DB read AND maybeCondense entirely (Phase 02 behavior preserved)', async () => {
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'No session.' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      // NO sessionId
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: largeHistoryAboveDefaultThreshold(),
    });
    expect(result.finalText).toBe('No session.');
    expect(result.events.filter((e) => e.type === 'summarized')).toHaveLength(0);
    // No DB write triggered — both the restore read and the persist write skipped.
    expect(dbUpdateMock).not.toHaveBeenCalled();
    // The select mock callback was never invoked either (no DB read at all).
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('model undefined: skips maybeCondense (REQ-034 — cannot pick a backing model)', async () => {
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'No model.' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      // NO model
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: largeHistoryAboveDefaultThreshold(),
    });
    expect(result.finalText).toBe('No model.');
    expect(result.events.filter((e) => e.type === 'summarized')).toHaveLength(0);
    expect(dbUpdateMock).not.toHaveBeenCalled();
    // The restore read still fires (gated on sessionId only), so the select mock
    // should have been consulted once.
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it('multiple round-trips above threshold: summarizer can fire multiple times across turns', async () => {
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '1000');
    // Three round-trips: each iteration triggers maybeCondense (the working
    // history grows after each tool dispatch, staying above 1000 tokens).
    //   Iter 1: summarizer text response → loop main: tool_use (read_vault_multi)
    //   Iter 2: summarizer text response → loop main: tool_use (list_vault)
    //   Iter 3: summarizer text response → loop main: end_turn
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'text', text: 'Summary 1.' }] }, // summarizer 1
      { contentBlocks: [{ type: 'tool_use', id: 'tu_1', name: 'list_vault', input: { directory: '/' } }] },
      { contentBlocks: [{ type: 'text', text: 'Summary 2.' }] }, // summarizer 2
      { contentBlocks: [{ type: 'tool_use', id: 'tu_2', name: 'list_vault', input: { directory: '/' } }] },
      { contentBlocks: [{ type: 'text', text: 'Summary 3.' }] }, // summarizer 3
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Fine.' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: largeHistoryAboveDefaultThreshold(),
    });
    expect(result.finalText).toBe('Fine.');
    // Each round-trip iteration calls maybeCondense BEFORE the provider —
    // expect three summarized events (one per loop iteration).
    expect(result.events.filter((e) => e.type === 'summarized')).toHaveLength(3);
    expect(dbUpdateMock).toHaveBeenCalledTimes(3);
  });

  it('DB read failure during restore is non-fatal: loop proceeds with unaugmented history', async () => {
    // Simulate a DB outage on the restore-read path. The loop must NOT crash
    // and the summarizer must not fire (history stays small).
    dbSelectMock.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });
    const provider = inspectableProvider([
      { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: 'Survived.' } }] },
    ]);
    const result = await runVaultToolLoop({
      provider,
      model: SUMM_MODEL,
      sessionId: SUMM_SESSION,
      systemBlocks: [{ type: 'text', text: 'system' }],
      history: smallHistory(),
    });
    expect(result.finalText).toBe('Survived.');
    // The provider's first call should have received the ORIGINAL messages,
    // not an augmented copy.
    const firstInput = (provider.completeMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CompleteMessageInput;
    expect(firstInput.messages).toHaveLength(smallHistory().length);
  });
});
