import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveMasterBackend, resolveVaultMutations } from '@/lib/preferences';
import { buildVaultSystemPrompt } from '@/ai/master/vault/prompt-builder';
import { VAULT_TOOL_DEFINITIONS, VAULT_TOOL_COUNT } from '@/ai/master/vault/tools';

/**
 * Phase 02 plan 02-08 — vaultMutations gate at the turn-route boundary.
 *
 * This file mirrors the pattern of `tests/sessions/turn-route-branch.test.ts`
 * (Phase 01) — unit-level coverage of the decision logic + the inputs the
 * vault branch passes to `buildVaultSystemPrompt` and `runVaultToolLoop`.
 * It does NOT exercise the full POST handler (which would require Clerk
 * auth, DB, lock, and a live LLM provider stub). End-to-end behaviour is
 * covered by the manual smoke checklist in the plan's Verification block.
 *
 * Coverage matrix: the four quadrants of (masterBackend, vaultMutations):
 *
 *   1. vault + vaultMutations=true  → full vault write path
 *      (4-tool prompt, apply_event mention, campaignId forwarded)
 *   2. vault + vaultMutations=false → read-only vault path
 *      (3-tool prompt, no apply_event mention, no campaignId)
 *   3. vault + vaultMutations=undefined → defaults to read-only
 *      (same as Q2; resolveVaultMutations returns false on undefined)
 *   4. baked + vaultMutations=true  → baked path, gate ignored (Pitfall 5)
 *      (resolveVaultMutations returns false despite vaultMutations:true)
 *
 * Plus an env-override interaction describe for the MASTER_BACKEND env var
 * (the developer escape hatch for ops / CI smoke testing without DB rows).
 */

describe('turn route — vaultMutations gate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  describe('masterBackend=vault + vaultMutations=true → full vault write path', () => {
    const userPrefs = {
      masterBackend: 'vault' as const,
      vaultMutations: true,
      aiMasterModel: 'qwen3:30b-a3b-instruct-2507-q4_K_M',
    };

    it('resolveMasterBackend honours stored vault', () => {
      expect(resolveMasterBackend(userPrefs.masterBackend)).toBe('vault');
    });

    it('resolveVaultMutations returns true', () => {
      expect(resolveVaultMutations(userPrefs)).toBe(true);
    });

    it('the prompt built for this campaign advertises 4 tools', () => {
      const enabled = resolveVaultMutations(userPrefs);
      const prompt = buildVaultSystemPrompt({
        vaultRoot: '/data/vault',
        campaignId: '11111111-2222-3333-4444-555555555555',
        toolCount: enabled ? 4 : 3,
        vaultMutations: enabled,
      });
      expect(prompt).toContain('4 listed tools');
    });

    it('the prompt mentions apply_event', () => {
      const enabled = resolveVaultMutations(userPrefs);
      const prompt = buildVaultSystemPrompt({
        vaultRoot: '/data/vault',
        campaignId: '11111111-2222-3333-4444-555555555555',
        toolCount: enabled ? 4 : 3,
        vaultMutations: enabled,
      });
      expect(prompt).toContain('apply_event');
    });

    it('the prompt mentions character UUID (NIT 1 — UUID-vs-name)', () => {
      const enabled = resolveVaultMutations(userPrefs);
      const prompt = buildVaultSystemPrompt({
        vaultRoot: '/data/vault',
        campaignId: '11111111-2222-3333-4444-555555555555',
        toolCount: enabled ? 4 : 3,
        vaultMutations: enabled,
      });
      expect(prompt).toContain('character UUID');
    });

    it('the loop receives campaignId (simulated via the spread pattern)', () => {
      const campaignId = '11111111-2222-3333-4444-555555555555';
      const enabled = resolveVaultMutations(userPrefs);
      // Simulate the route's conditional spread: when enabled, campaignId is
      // present in the loop-input object; when not, the key is absent.
      const loopInput = {
        provider: 'stub',
        ...(enabled && { campaignId }),
      };
      expect(loopInput).toHaveProperty('campaignId', campaignId);
    });
  });

  describe('masterBackend=vault + vaultMutations=false → read-only vault path', () => {
    const userPrefs = {
      masterBackend: 'vault' as const,
      vaultMutations: false,
      aiMasterModel: 'qwen3:30b-a3b-instruct-2507-q4_K_M',
    };

    it('resolveVaultMutations returns false', () => {
      expect(resolveVaultMutations(userPrefs)).toBe(false);
    });

    it('the prompt built for this campaign advertises 3 tools (read-only)', () => {
      const enabled = resolveVaultMutations(userPrefs);
      const prompt = buildVaultSystemPrompt({
        vaultRoot: '/data/vault',
        campaignId: '11111111-2222-3333-4444-555555555555',
        toolCount: enabled ? 4 : 3,
        vaultMutations: enabled,
      });
      expect(prompt).toContain('3 listed tools');
    });

    it('the prompt does NOT mention apply_event', () => {
      const enabled = resolveVaultMutations(userPrefs);
      const prompt = buildVaultSystemPrompt({
        vaultRoot: '/data/vault',
        campaignId: '11111111-2222-3333-4444-555555555555',
        toolCount: enabled ? 4 : 3,
        vaultMutations: enabled,
      });
      expect(prompt).not.toContain('apply_event');
    });

    it('the loop does NOT receive campaignId (key is absent in spread)', () => {
      const campaignId = '11111111-2222-3333-4444-555555555555';
      const enabled = resolveVaultMutations(userPrefs);
      const loopInput = {
        provider: 'stub',
        ...(enabled && { campaignId }),
      };
      expect(loopInput).not.toHaveProperty('campaignId');
    });
  });

  describe('masterBackend=vault + vaultMutations=undefined → read-only (default)', () => {
    const userPrefs = {
      masterBackend: 'vault' as const,
      aiMasterModel: 'qwen3:30b-a3b-instruct-2507-q4_K_M',
    };

    it('resolveVaultMutations returns false on undefined (matches false case)', () => {
      expect(resolveVaultMutations(userPrefs)).toBe(false);
    });

    it('the prompt built for this campaign advertises 3 tools', () => {
      const enabled = resolveVaultMutations(userPrefs);
      const prompt = buildVaultSystemPrompt({
        vaultRoot: '/data/vault',
        campaignId: '11111111-2222-3333-4444-555555555555',
        toolCount: enabled ? 4 : 3,
        vaultMutations: enabled,
      });
      expect(prompt).toContain('3 listed tools');
      expect(prompt).not.toContain('apply_event');
    });
  });

  describe('masterBackend=baked + vaultMutations=true → baked path, gate ignored (Pitfall 5)', () => {
    // The operator set vaultMutations:true on a baked-backend campaign. The
    // gate MUST stay false — only the (vault + vaultMutations:true) combo
    // unlocks apply_event. This is the resolver-level enforcement of Pitfall
    // 5: orthogonal flags, no cross-contamination.
    const userPrefs = {
      masterBackend: 'baked' as const,
      vaultMutations: true,
      aiMasterModel: 'claude-sonnet-4-5',
    };

    it('resolveMasterBackend returns baked', () => {
      expect(resolveMasterBackend(userPrefs.masterBackend)).toBe('baked');
    });

    it('resolveVaultMutations returns false even when vaultMutations:true is stored', () => {
      // Pitfall 5 — the orphan flag has NO effect on a baked campaign.
      expect(resolveVaultMutations(userPrefs)).toBe(false);
    });

    it('a baked campaign never enters the vault branch (masterBackend !== vault)', () => {
      // The route's outer guard: `if (masterBackend === 'vault')`. A baked
      // backend short-circuits before any vault-builder call, regardless of
      // the orphan vaultMutations:true.
      const masterBackend = resolveMasterBackend(userPrefs.masterBackend);
      expect(masterBackend).not.toBe('vault');
    });
  });

  describe('env override interaction (MASTER_BACKEND)', () => {
    it('env MASTER_BACKEND=vault + no stored backend + vaultMutations:true → full vault write path', () => {
      vi.stubEnv('MASTER_BACKEND', 'vault');
      const userPrefs = {
        masterBackend: undefined,
        vaultMutations: true,
      };
      // resolveMasterBackend cascades to env when stored is undefined.
      expect(resolveMasterBackend(userPrefs.masterBackend)).toBe('vault');
      // resolveVaultMutations then resolves via the SAME helper, so the env
      // override propagates: gate is true.
      expect(resolveVaultMutations(userPrefs)).toBe(true);
    });

    it('env MASTER_BACKEND=vault + masterBackend:baked stored → stored wins, vaultMutations has no effect', () => {
      vi.stubEnv('MASTER_BACKEND', 'vault');
      const userPrefs = {
        masterBackend: 'baked' as const,
        vaultMutations: true,
      };
      // Stored explicit value wins over the env override.
      expect(resolveMasterBackend(userPrefs.masterBackend)).toBe('baked');
      // And the orphan flag still resolves to false (Pitfall 5).
      expect(resolveVaultMutations(userPrefs)).toBe(false);
    });
  });

  describe('VAULT_TOOL_DEFINITIONS — dispatch surface is always 4 (belt-and-suspenders)', () => {
    // The loop ALWAYS receives the full 4-tool dispatch surface; the gate
    // is enforced at the prompt level (the LLM is told about 3 vs 4 tools)
    // AND at the dispatcher level (apply_event without a campaignId
    // returns isError). Both layers fail-closed.
    it('the dispatch surface has 4 tool entries unconditionally', () => {
      expect(VAULT_TOOL_DEFINITIONS).toHaveLength(4);
      expect(VAULT_TOOL_COUNT).toBe(4);
    });

    it('apply_event is in the dispatch surface (Phase 02 added the 4th tool)', () => {
      expect(VAULT_TOOL_DEFINITIONS.map((t) => t.name)).toContain('apply_event');
    });
  });
});
