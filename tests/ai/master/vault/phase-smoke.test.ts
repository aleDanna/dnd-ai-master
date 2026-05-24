import { describe, it, expect } from 'vitest';

/**
 * Plan 09 smoke test for Phase 01 (vault-llm-wiki migration).
 *
 * Asserts every public symbol from `src/ai/master/vault/index.ts` is
 * importable via the barrel. Catches the class of regressions where a
 * single `export * from './<file>'` line gets removed during refactor and
 * the focused per-submodule tests still pass (because they import from
 * the specific submodule, not the barrel) but downstream consumers
 * importing from `@/ai/master/vault` break.
 */
describe('vault phase smoke', () => {
  it('imports all public symbols from the barrel', async () => {
    const mod = await import('@/ai/master/vault');
    // Path primitives (plan 01)
    expect(typeof mod.VAULT_ROOT).toBe('string');
    expect(typeof mod.safeVaultPath).toBe('function');
    expect(typeof mod.readVaultFile).toBe('function');
    expect(typeof mod.listVaultDir).toBe('function');
    // Prompt builder (plan 02)
    expect(typeof mod.buildVaultSystemPrompt).toBe('function');
    expect(typeof mod.hashVaultPrompt).toBe('function');
    // Tools (plan 03)
    expect(Array.isArray(mod.VAULT_TOOL_DEFINITIONS)).toBe(true);
    expect(mod.VAULT_TOOL_DEFINITIONS).toHaveLength(3);
    expect(typeof mod.VAULT_TOOL_COUNT).toBe('number');
    expect(typeof mod.dispatchVaultTool).toBe('function');
    expect(typeof mod.formatMultiReadResult).toBe('function');
    // Loop (plan 04)
    expect(typeof mod.runVaultToolLoop).toBe('function');
  });

  it('VAULT_TOOL_COUNT matches the definitions length', async () => {
    const mod = await import('@/ai/master/vault');
    expect(mod.VAULT_TOOL_COUNT).toBe(mod.VAULT_TOOL_DEFINITIONS.length);
  });

  it('no tool named `read_vault` (REQ-011)', async () => {
    const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).not.toContain('read_vault');
  });

  it('no tool named `apply_event` (Phase 01 scope — Phase 02 will add it)', async () => {
    const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).not.toContain('apply_event');
  });
});
