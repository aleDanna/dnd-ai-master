import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock db client so the suite can run without a Postgres connection. We
// swap TEST_CAMPAIGN_SETTINGS between cases to drive getCampaignSettings.
// (The same chain shape works for users.preferences in the unused branch.)
let TEST_CAMPAIGN_SETTINGS: Record<string, unknown> | null = {};

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (TEST_CAMPAIGN_SETTINGS === null ? [] : [{ settings: TEST_CAMPAIGN_SETTINGS, preferences: TEST_CAMPAIGN_SETTINGS }]),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

import {
  resolveVaultMutations,
  validateSettingsPatch,
  getCampaignSettings,
  VAULT_MUTATIONS_STALE_UI_BANNER,
} from '@/lib/preferences';
import type { MasterBackend } from '@/lib/preferences';

describe('vault-mutations flag (Phase 02 — Decision 5, Pitfall 5)', () => {
  describe('validateSettingsPatch — vaultMutations arm', () => {
    it('accepts true', () => {
      const result = validateSettingsPatch({ vaultMutations: true });
      expect(result).toEqual({ ok: true, patch: { vaultMutations: true } });
    });

    it('accepts false', () => {
      const result = validateSettingsPatch({ vaultMutations: false });
      expect(result).toEqual({ ok: true, patch: { vaultMutations: false } });
    });

    it('accepts undefined (clear)', () => {
      const result = validateSettingsPatch({ vaultMutations: undefined });
      expect(result).toEqual({ ok: true, patch: { vaultMutations: undefined } });
    });

    it('rejects string', () => {
      const bad = { vaultMutations: 'true' as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-vaultMutations' });
    });

    it('rejects number', () => {
      const bad = { vaultMutations: 1 as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-vaultMutations' });
    });

    it('rejects object', () => {
      const bad = { vaultMutations: { value: true } as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-vaultMutations' });
    });

    it('does not affect masterBackend arm (combined patch validates both)', () => {
      const result = validateSettingsPatch({ masterBackend: 'vault', vaultMutations: true });
      expect(result).toEqual({
        ok: true,
        patch: { masterBackend: 'vault', vaultMutations: true },
      });
    });

    it('does not introduce the field when absent from body', () => {
      const result = validateSettingsPatch({ manualRolls: true });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.patch).not.toHaveProperty('vaultMutations');
    });
  });

  describe('resolveVaultMutations — Pitfall 5 invariants', () => {
    beforeEach(() => {
      // Pin env so env-default masterBackend doesn't leak across cases.
      vi.stubEnv('MASTER_BACKEND', '');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns true when both flags align (vault + true)', () => {
      expect(
        resolveVaultMutations({ masterBackend: 'vault', vaultMutations: true }),
      ).toBe(true);
    });

    it('returns false when baked + vaultMutations:true (Pitfall 5 — THE invariant)', () => {
      // The key assertion: vaultMutations has no effect on baked campaigns.
      // resolveVaultMutations enforces this at the resolver level so the
      // turn route doesn't expose apply_event on a baked campaign even if
      // the operator accidentally flipped the flag.
      expect(
        resolveVaultMutations({ masterBackend: 'baked', vaultMutations: true }),
      ).toBe(false);
    });

    it('returns false when vault + vaultMutations:false', () => {
      expect(
        resolveVaultMutations({ masterBackend: 'vault', vaultMutations: false }),
      ).toBe(false);
    });

    it('returns false when vault + vaultMutations:undefined (opt-in default)', () => {
      expect(
        resolveVaultMutations({ masterBackend: 'vault', vaultMutations: undefined }),
      ).toBe(false);
    });

    it('returns false when settings undefined', () => {
      expect(resolveVaultMutations(undefined)).toBe(false);
    });

    it('returns false when settings empty {}', () => {
      expect(resolveVaultMutations({})).toBe(false);
    });

    it('respects env MASTER_BACKEND=vault when no stored backend', () => {
      // Env-default resolveMasterBackend returns 'vault'; combined with
      // vaultMutations:true the resolver returns true. Confirms the env
      // override flows through (Phase 01 resolver pattern, applied here).
      vi.stubEnv('MASTER_BACKEND', 'vault');
      expect(resolveVaultMutations({ vaultMutations: true })).toBe(true);
    });

    it('env MASTER_BACKEND=vault + stored baked → stored wins (false)', () => {
      // Stored value always wins per resolveMasterBackend semantics.
      vi.stubEnv('MASTER_BACKEND', 'vault');
      const stored: { masterBackend: MasterBackend; vaultMutations: boolean } = {
        masterBackend: 'baked',
        vaultMutations: true,
      };
      expect(resolveVaultMutations(stored)).toBe(false);
    });
  });

  describe('getCampaignSettings — vaultMutations resolution', () => {
    beforeEach(() => {
      vi.stubEnv('MASTER_BACKEND', '');
      vi.stubEnv('MASTER_PROVIDER', '');
      vi.stubEnv('IMAGE_PROVIDER', '');
      vi.stubEnv('TTS_PROVIDER', '');
      TEST_CAMPAIGN_SETTINGS = {};
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns true when stored {masterBackend:vault, vaultMutations:true}', async () => {
      TEST_CAMPAIGN_SETTINGS = { masterBackend: 'vault', vaultMutations: true };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000001');
      expect(s.vaultMutations).toBe(true);
    });

    it('returns false when stored {masterBackend:baked, vaultMutations:true} (Pitfall 5)', async () => {
      // Pitfall 5: even though vaultMutations:true is stored, the resolver
      // returns false because masterBackend is baked. getCampaignSettings
      // wires resolveVaultMutations so the surface stays consistent.
      TEST_CAMPAIGN_SETTINGS = { masterBackend: 'baked', vaultMutations: true };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000002');
      expect(s.vaultMutations).toBe(false);
    });

    it('returns false when stored is empty {} (default)', async () => {
      TEST_CAMPAIGN_SETTINGS = {};
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000003');
      expect(s.vaultMutations).toBe(false);
    });

    it('returns false when stored {masterBackend:vault, vaultMutations:false}', async () => {
      TEST_CAMPAIGN_SETTINGS = { masterBackend: 'vault', vaultMutations: false };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000004');
      expect(s.vaultMutations).toBe(false);
    });

    it('throws when the campaign row is missing', async () => {
      TEST_CAMPAIGN_SETTINGS = null;
      await expect(
        getCampaignSettings('00000000-0000-0000-0000-000000000099'),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('VAULT_MUTATIONS_STALE_UI_BANNER — operator-approved copy', () => {
    // Phase 02 plan 02-08 Task 5 (checkpoint:human-verify) — the operator
    // approved Option A (Settings-page banner) with the Italian copy
    // matching the One Piece campaign language. This test locks the exact
    // string so future plans (02-10 operator doc, eventual UI panel) can
    // reference it without re-checkpointing the wording.
    it('exposes the locked Italian banner string', () => {
      expect(VAULT_MUTATIONS_STALE_UI_BANNER).toBe(
        'Vault attivo — ricarica per vedere lo stato più recente',
      );
    });
  });
});
