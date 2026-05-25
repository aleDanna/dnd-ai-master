import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveMasterBackend } from '@/lib/preferences';
import { buildVaultSystemPrompt } from '@/ai/master/vault/prompt-builder';
import { VAULT_TOOL_DEFINITIONS, VAULT_TOOL_COUNT } from '@/ai/master/vault/tools';

/**
 * Branch-selection test for the turn-route vault path.
 *
 * This is a focused unit test of the decision logic and the inputs the
 * vault branch passes to `runVaultToolLoop`. It does NOT exercise the
 * full POST handler (which would require Clerk auth, DB, lock, etc.) —
 * for end-to-end behaviour see the manual smoke checklist in Phase 01
 * Plan 07's Verification section, and the bench-vault-m4 runner in
 * Plan 08.
 *
 * What we DO verify here:
 *  1. resolveMasterBackend honours stored value over env override
 *  2. The system prompt the vault branch would build contains the
 *     vault root, the campaign id, and the lenient discovery line
 *  3. The vault tool surface is exactly 4 tools (Phase 02 added
 *     apply_event; the surface still excludes engine state-mutation
 *     tools) and does not contain a singular read_vault
 */

describe('turn-route vault branch — resolveMasterBackend behaviour', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses baked when neither stored nor env are set', () => {
    vi.stubEnv('MASTER_BACKEND', '');
    expect(resolveMasterBackend(undefined)).toBe('baked');
  });

  it('uses env override when no stored value', () => {
    vi.stubEnv('MASTER_BACKEND', 'vault');
    expect(resolveMasterBackend(undefined)).toBe('vault');
  });

  it('stored vault wins over env baked', () => {
    vi.stubEnv('MASTER_BACKEND', 'baked');
    expect(resolveMasterBackend('vault')).toBe('vault');
  });

  it('stored baked wins over env vault', () => {
    vi.stubEnv('MASTER_BACKEND', 'vault');
    expect(resolveMasterBackend('baked')).toBe('baked');
  });
});

describe('turn-route vault branch — system prompt contents', () => {
  it('built prompt references the vault root path', () => {
    const sys = buildVaultSystemPrompt({
      vaultRoot: '/abs/data/vault',
      campaignId: 'test-campaign-uuid',
      toolCount: VAULT_TOOL_COUNT,
    });
    expect(sys).toContain('/abs/data/vault');
  });

  it('built prompt references the campaign id (Active campaign block)', () => {
    const sys = buildVaultSystemPrompt({
      vaultRoot: '/data/vault',
      campaignId: '11111111-2222-3333-4444-555555555555',
      toolCount: 3,
    });
    expect(sys).toContain('/campaigns/11111111-2222-3333-4444-555555555555/');
  });

  it('built prompt references /tools/index.md (REQ-012 lenient discovery)', () => {
    const sys = buildVaultSystemPrompt({ vaultRoot: '/v', campaignId: 'x', toolCount: 3 });
    expect(sys).toContain('/tools/index.md');
  });

  it('built prompt does NOT reference engine tools, RAG, SRD, or handbook injection', () => {
    const sys = buildVaultSystemPrompt({ vaultRoot: '/v', campaignId: 'x', toolCount: 3 });
    expect(sys).not.toMatch(/cast_spell|set_current_player|apply_damage|roll_initiative/);
    expect(sys).not.toMatch(/REWARDS_MANDATE|ROLL_TRIGGERS|MANUAL_ROLLS_RULE|set_tonal_frame/);
    expect(sys).not.toMatch(/<srd>|<handbook>|<world_lore>/);
  });

  it('built prompt respects the language parameter when provided', () => {
    const withLang = buildVaultSystemPrompt({ vaultRoot: '/v', campaignId: 'x', toolCount: 3, language: 'it' });
    const without = buildVaultSystemPrompt({ vaultRoot: '/v', campaignId: 'x', toolCount: 3 });
    expect(withLang).toContain('Respond in language: it.');
    expect(without).not.toContain('Respond in language');
  });
});

describe('turn-route vault branch — tool surface (REQ-010, REQ-011, Phase 02)', () => {
  it('exposes exactly 4 tools (Phase 02 adds apply_event)', () => {
    expect(VAULT_TOOL_DEFINITIONS).toHaveLength(4);
    expect(VAULT_TOOL_COUNT).toBe(4);
  });

  it('does NOT expose a singular read_vault tool (REQ-011)', () => {
    expect(VAULT_TOOL_DEFINITIONS.map((t) => t.name)).not.toContain('read_vault');
  });

  it('does NOT expose engine state-mutation tools (vault path is engine-tool-free)', () => {
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).not.toContain('cast_spell');
    expect(names).not.toContain('set_current_player');
    expect(names).not.toContain('apply_damage');
    expect(names).not.toContain('roll_initiative');
    // apply_event IS exposed in Phase 02 — see "exposes the four vault tools by name" case below.
  });

  it('exposes the four vault tools by name (Phase 02 surface)', () => {
    const names = new Set(VAULT_TOOL_DEFINITIONS.map((t) => t.name));
    expect(names).toEqual(new Set(['read_vault_multi', 'list_vault', 'end_turn', 'apply_event']));
  });
});

describe('turn-route vault branch — VAULT_ROOT resolution', () => {
  it('points at data/vault from the project root', async () => {
    const { VAULT_ROOT } = await import('@/ai/master/vault/path');
    expect(VAULT_ROOT.endsWith('/data/vault')).toBe(true);
  });
});
