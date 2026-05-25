import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TURN_TOOL_CALL_CAP, VAULT_TURN_TOOL_CALL_CAP } from '@/sessions/types';
import { runVaultToolLoop } from '@/ai/master/vault/loop';
import type {
  MasterProvider,
  CompleteMessageInput,
  CompleteMessageOutput,
  ContentBlock,
  NormalizedUsage,
} from '@/ai/provider/types';

/**
 * Phase 02 / Plan 06 — Regression test for the tool-call cap separation
 * between the baked path (`TURN_TOOL_CALL_CAP = 12`) and the vault path
 * (`VAULT_TURN_TOOL_CALL_CAP = 20`).
 *
 * The cap bump was introduced by Plan 02-06 (Pitfall 4 in 02-RESEARCH.md):
 * vault-mutation combat turns easily fire 15-20 apply_event calls per turn,
 * which would truncate under the smaller baked-path cap.
 *
 * This test file lives under `tests/sessions/` (not `tests/ai/master/vault/`)
 * because the cap constants are owned by `src/sessions/types.ts`. The
 * file co-locates the cap separation invariant with the constants module.
 */

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Scripted MasterProvider — same pattern as tests/ai/master/vault/loop.test.ts. */
function scriptedProvider(responses: { contentBlocks: ContentBlock[] }[]): MasterProvider {
  let idx = 0;
  return {
    name: 'anthropic',
    async completeMessage(_input: CompleteMessageInput): Promise<CompleteMessageOutput> {
      const entry = responses[idx];
      idx += 1;
      if (!entry) throw new Error(`scriptedProvider: no response queued for call #${idx}`);
      return {
        contentBlocks: entry.contentBlocks,
        stopReason: entry.contentBlocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: EMPTY_USAGE,
      };
    },
    async detectLanguage() {
      return { code: null, usage: EMPTY_USAGE };
    },
    async proposeWizard() {
      return { toolInput: {}, usage: EMPTY_USAGE };
    },
  } as unknown as MasterProvider;
}

const BASE_INPUT = {
  systemBlocks: [{ type: 'text' as const, text: 'system' }],
  history: [{ role: 'user' as const, content: 'Hello.' }],
};

describe('turn-tool-call cap separation', () => {
  describe('constants', () => {
    it('TURN_TOOL_CALL_CAP is 12 (baked path unchanged)', () => {
      expect(TURN_TOOL_CALL_CAP).toBe(12);
    });

    it('VAULT_TURN_TOOL_CALL_CAP is 20 (raised for combat turns)', () => {
      expect(VAULT_TURN_TOOL_CALL_CAP).toBe(20);
    });

    it('the two constants are distinct', () => {
      expect(TURN_TOOL_CALL_CAP).not.toBe(VAULT_TURN_TOOL_CALL_CAP);
    });
  });

  describe('runVaultToolLoop honors VAULT_TURN_TOOL_CALL_CAP as default', () => {
    let root: string;

    beforeAll(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'turn-tool-call-cap-test-'));
      root = join(dir, 'vault');
      await mkdir(join(root, 'handbook'), { recursive: true });
      await writeFile(join(root, 'handbook', 'a.md'), 'A.', 'utf8');
    });

    afterAll(async () => {
      await rm(resolve(root, '..'), { recursive: true, force: true });
    });

    it('does not truncate at 20 tool calls', async () => {
      // 20 read_vault_multi calls, then a 21st iteration with no tool_use
      // to break the loop via terminator 1 (no_tool_calls + content). The
      // default cap is VAULT_TURN_TOOL_CALL_CAP = 20, so exactly 20 calls
      // should succeed without triggering truncation.
      const calls = Array.from({ length: 20 }, (_, i) => ({
        contentBlocks: [
          {
            type: 'tool_use' as const,
            id: `tu_${i}`,
            name: 'read_vault_multi',
            input: { paths: ['/handbook/a.md'] },
          },
        ],
      }));
      const closer = { contentBlocks: [{ type: 'text' as const, text: 'done' }] };
      const provider = scriptedProvider([...calls, closer]);

      const result = await runVaultToolLoop({ provider, vaultRoot: root, ...BASE_INPUT });

      expect(result.toolCallCount).toBe(20);
      expect(result.truncated).toBe(false);
      expect(result.timedOut).toBe(false);
    });

    it('truncates at 21 tool calls', async () => {
      // 21 read_vault_multi calls — the 21st overflows VAULT_TURN_TOOL_CALL_CAP
      // and the cap-check in runVaultToolLoop fires `turn_error: tool_call_cap`.
      const responses = Array.from({ length: 21 }, (_, i) => ({
        contentBlocks: [
          {
            type: 'tool_use' as const,
            id: `tu_${i}`,
            name: 'read_vault_multi',
            input: { paths: ['/handbook/a.md'] },
          },
        ],
      }));
      const provider = scriptedProvider(responses);

      const result = await runVaultToolLoop({ provider, vaultRoot: root, ...BASE_INPUT });

      expect(result.truncated).toBe(true);
      expect(result.toolCallCount).toBe(20);
      expect(
        result.events.some((e) => e.type === 'turn_error' && e.reason === 'tool_call_cap'),
      ).toBe(true);
    });

    it('toolCallCap override still works', async () => {
      // Override cap = 5; provider returns 6 tool_use calls in a row.
      // The 6th overflows the override (taking precedence over the constant)
      // and truncation fires.
      const responses = Array.from({ length: 6 }, (_, i) => ({
        contentBlocks: [
          {
            type: 'tool_use' as const,
            id: `tu_${i}`,
            name: 'read_vault_multi',
            input: { paths: ['/handbook/a.md'] },
          },
        ],
      }));
      const provider = scriptedProvider(responses);

      const result = await runVaultToolLoop({
        provider,
        vaultRoot: root,
        toolCallCap: 5,
        ...BASE_INPUT,
      });

      expect(result.truncated).toBe(true);
      expect(result.toolCallCount).toBe(5);
    });
  });

  describe('runToolLoop still uses TURN_TOOL_CALL_CAP = 12', () => {
    // Static assertion — read the baked loop's source and prove it imports
    // the smaller cap, NOT the vault-path cap. This catches accidental
    // cross-contamination of the constants without needing to spin up the
    // full baked tool loop (which requires engine plumbing).
    it('imports TURN_TOOL_CALL_CAP and not VAULT_TURN_TOOL_CALL_CAP', () => {
      const tlSource = readFileSync(
        resolve(process.cwd(), 'src/ai/master/tool-loop.ts'),
        'utf8',
      );
      expect(tlSource).toMatch(/TURN_TOOL_CALL_CAP/);
      expect(tlSource).not.toMatch(/VAULT_TURN_TOOL_CALL_CAP/);
    });
  });
});
