import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  VAULT_TOOL_DEFINITIONS,
  VAULT_TOOL_COUNT,
  dispatchVaultTool,
  formatMultiReadResult,
} from '@/ai/master/vault/tools';

describe('VAULT_TOOL_DEFINITIONS shape', () => {
  it('contains exactly 3 tools (apply_event arrives in Phase 02)', () => {
    expect(VAULT_TOOL_DEFINITIONS).toHaveLength(3);
    expect(VAULT_TOOL_COUNT).toBe(3);
  });

  it('names are read_vault_multi, list_vault, end_turn', () => {
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['read_vault_multi', 'list_vault', 'end_turn']);
  });

  it('NEVER includes a tool named `read_vault` (REQ-011)', () => {
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).not.toContain('read_vault');
  });

  it('read_vault_multi description includes the "Read MANY ... in ONE call" wording (spike 009)', () => {
    const def = VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'read_vault_multi');
    expect(def?.description).toMatch(/Read MANY .* in ONE call/);
  });

  it('every tool has a non-empty description and an object input_schema', () => {
    for (const def of VAULT_TOOL_DEFINITIONS) {
      expect(typeof def.description).toBe('string');
      expect((def.description ?? '').length).toBeGreaterThan(0);
      expect(def.input_schema.type).toBe('object');
    }
  });
});

describe('dispatchVaultTool — read_vault_multi', () => {
  let root: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-tools-test-'));
    root = join(dir, 'vault');
    await mkdir(join(root, 'handbook'), { recursive: true });
    await writeFile(join(root, 'handbook', 'a.md'), 'AAA', 'utf8');
    await writeFile(join(root, 'handbook', 'b.md'), 'BBB', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  it('reads multiple files in concat format', async () => {
    const result = await dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/a.md', '/handbook/b.md'] },
      { vaultRoot: root },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('### /handbook/a.md\n\nAAA\n\n---\n\n### /handbook/b.md\n\nBBB');
  });

  it('rejects empty paths array', async () => {
    const result = await dispatchVaultTool('read_vault_multi', { paths: [] }, { vaultRoot: root });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/non-empty paths array/);
  });

  it('rejects more than 16 paths', async () => {
    const paths = Array.from({ length: 17 }, (_, i) => `/handbook/${i}.md`);
    const result = await dispatchVaultTool('read_vault_multi', { paths }, { vaultRoot: root });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/at most 16 paths/);
  });

  it('surfaces missing files inline; batch does not fail', async () => {
    const result = await dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/a.md', '/handbook/missing.md'] },
      { vaultRoot: root },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('AAA');
    expect(result.content).toContain('ERROR: file not found at /handbook/missing.md');
  });

  it('surfaces traversal attempt inline; sibling reads succeed', async () => {
    const result = await dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/a.md', '../etc/passwd'] },
      { vaultRoot: root },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('AAA');
    expect(result.content).toContain('ERROR: path outside vault');
  });

  it('rejects missing paths field', async () => {
    const result = await dispatchVaultTool('read_vault_multi', {}, { vaultRoot: root });
    expect(result.isError).toBe(true);
  });
});

describe('dispatchVaultTool — list_vault', () => {
  let root: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-list-test-'));
    root = join(dir, 'vault');
    await mkdir(join(root, 'handbook'), { recursive: true });
    await writeFile(join(root, 'handbook', 'a.md'), '', 'utf8');
    await writeFile(join(root, 'handbook', 'b.md'), '', 'utf8');
    await writeFile(join(root, 'handbook', 'c.md'), '', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  it('lists sorted children with header', async () => {
    const result = await dispatchVaultTool('list_vault', { directory: '/handbook' }, { vaultRoot: root });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Children of /handbook:\n- a.md\n- b.md\n- c.md');
  });

  it('returns "(no children or path not found)" for a missing directory', async () => {
    const result = await dispatchVaultTool('list_vault', { directory: '/does/not/exist' }, { vaultRoot: root });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('(no children or path not found)');
  });

  it('rejects non-string directory', async () => {
    const result = await dispatchVaultTool('list_vault', { directory: 123 }, { vaultRoot: root });
    expect(result.isError).toBe(true);
  });
});

describe('dispatchVaultTool — end_turn', () => {
  it('returns endTurnResponse for valid response', async () => {
    const result = await dispatchVaultTool('end_turn', { response: 'Final narrative.' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('');
    expect(result.endTurnResponse).toBe('Final narrative.');
  });

  it('defaults to empty string when response is missing', async () => {
    const result = await dispatchVaultTool('end_turn', {});
    expect(result.isError).toBe(false);
    expect(result.endTurnResponse).toBe('');
  });

  it('coerces non-string response to empty string', async () => {
    const result = await dispatchVaultTool('end_turn', { response: 123 });
    expect(result.endTurnResponse).toBe('');
  });
});

describe('dispatchVaultTool — unknown tool', () => {
  it('returns error marker without throwing', async () => {
    const result = await dispatchVaultTool('apply_event', { type: 'hp_change', payload: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown vault tool: apply_event');
  });
});

describe('formatMultiReadResult', () => {
  it('preserves the supplied order (no sorting)', () => {
    const result = formatMultiReadResult([
      { path: '/b', content: 'BB' },
      { path: '/a', content: 'AA' },
    ]);
    expect(result).toBe('### /b\n\nBB\n\n---\n\n### /a\n\nAA');
  });

  it('handles a single entry', () => {
    const result = formatMultiReadResult([{ path: '/only', content: 'X' }]);
    expect(result).toBe('### /only\n\nX');
  });

  it('handles an empty input gracefully', () => {
    expect(formatMultiReadResult([])).toBe('');
  });
});
