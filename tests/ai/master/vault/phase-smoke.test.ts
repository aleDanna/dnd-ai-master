import { describe, it, expect } from 'vitest';

/**
 * Smoke test for the vault module barrel (`src/ai/master/vault/index.ts`).
 *
 * Asserts every public symbol from the barrel is importable. Catches the
 * class of regressions where a single `export * from './<file>'` line gets
 * removed during refactor and the focused per-submodule tests still pass
 * (because they import from the specific submodule, not the barrel) but
 * downstream consumers importing from `@/ai/master/vault` break.
 *
 * Phase 01 plan 09 introduced the smoke test; phase 02 plan 02-07 inverts
 * the tool-count assertion (3 → 4, includes apply_event) and adds smoke
 * checks for every Phase 02 module.
 */
describe('vault phase smoke', () => {
  it('imports all public symbols from the barrel', async () => {
    const mod = await import('@/ai/master/vault');
    // Phase 01 — Path primitives (plan 01)
    expect(typeof mod.VAULT_ROOT).toBe('string');
    expect(typeof mod.VAULT_CAMPAIGNS_ROOT).toBe('string'); // REQ-007 — Phase 02 consumer
    expect(typeof mod.safeVaultPath).toBe('function');
    expect(typeof mod.readVaultFile).toBe('function');
    expect(typeof mod.listVaultDir).toBe('function');
    // Phase 01 — Prompt builder (plan 02)
    expect(typeof mod.buildVaultSystemPrompt).toBe('function');
    expect(typeof mod.hashVaultPrompt).toBe('function');
    // Phase 01/02 — Tools (plan 03 — Phase 01 shipped 3; plan 02-07 closes REQ-010 with apply_event)
    expect(Array.isArray(mod.VAULT_TOOL_DEFINITIONS)).toBe(true);
    expect(mod.VAULT_TOOL_DEFINITIONS).toHaveLength(4); // Phase 02 adds apply_event
    expect(typeof mod.VAULT_TOOL_COUNT).toBe('number');
    expect(typeof mod.dispatchVaultTool).toBe('function');
    expect(typeof mod.formatMultiReadResult).toBe('function');
    // Phase 01 — Loop (plan 04)
    expect(typeof mod.runVaultToolLoop).toBe('function');

    // Phase 02 — Events schema (plan 02-01)
    expect(typeof mod.validateEvent).toBe('function');
    expect(Array.isArray(mod.VAULT_EVENT_TYPES)).toBe(true);
    expect(mod.VAULT_EVENT_TYPES).toContain('hp_change');
    expect(typeof mod.EVENT_SCHEMA_VERSION).toBe('number');
    // Phase 02 — Campaign paths (plan 02-02)
    expect(typeof mod.eventsPath).toBe('function');
    expect(typeof mod.characterViewPath).toBe('function');
    expect(typeof mod.campaignDir).toBe('function');
    expect(typeof mod.slugifyCharacterName).toBe('function');
    expect(mod.UUID_REGEX).toBeInstanceOf(RegExp);
    // Phase 02 — Events writer (plan 02-03)
    expect(typeof mod.EventsWriter).toBe('function');
    expect(typeof mod.EventsWriter.applyEvent).toBe('function');
    // Phase 02 — Projector (plan 02-04)
    expect(typeof mod.applyEvent).toBe('function');
    expect(typeof mod.replayEvents).toBe('function');
    expect(typeof mod.regenerateCharacterView).toBe('function');
    expect(typeof mod.regenerateAffectedViews).toBe('function');
    // Phase 02 — Coexistence gate (plan 02-05)
    expect(typeof mod.resolveVaultMutations).toBe('function');
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

  it('tool named `apply_event` is present (Phase 02 closes REQ-010)', async () => {
    const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain('apply_event');
  });
});
