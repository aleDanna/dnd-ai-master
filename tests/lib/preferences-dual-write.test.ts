import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock db client so the suite can run without a Postgres connection. We
// swap TEST_CAMPAIGN_SETTINGS between cases to drive getCampaignSettings.
// (Mirror Phase 02 preferences-vault-mutations.test.ts shape verbatim.)
let TEST_CAMPAIGN_SETTINGS: Record<string, unknown> | null = {};

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            TEST_CAMPAIGN_SETTINGS === null
              ? []
              : [{ settings: TEST_CAMPAIGN_SETTINGS, preferences: TEST_CAMPAIGN_SETTINGS }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

import {
  resolveDualWrite,
  validateSettingsPatch,
  getCampaignSettings,
} from '@/lib/preferences';

describe('dualWrite flag (Phase 03-A — Decision 2)', () => {
  describe('resolveDualWrite — defensive resolution', () => {
    it('returns false when settings undefined', () => {
      expect(resolveDualWrite(undefined)).toBe(false);
    });

    it('returns false when settings empty {}', () => {
      expect(resolveDualWrite({})).toBe(false);
    });

    it('returns true when settings.dualWrite === true', () => {
      expect(resolveDualWrite({ dualWrite: true })).toBe(true);
    });

    it('returns false when settings.dualWrite === false', () => {
      expect(resolveDualWrite({ dualWrite: false })).toBe(false);
    });

    it('returns false when settings.dualWrite === undefined (Phase 02 default)', () => {
      expect(resolveDualWrite({ dualWrite: undefined })).toBe(false);
    });

    it('returns false for non-boolean truthy values (defensive — string)', () => {
      // The runtime gate uses strict equality so a malformed jsonb row
      // (stored 'yes' instead of true) cannot accidentally enable
      // dual-write fan-out.
      expect(
        resolveDualWrite({ dualWrite: 'yes' as unknown as boolean }),
      ).toBe(false);
    });

    it('returns false for non-boolean truthy values (defensive — number)', () => {
      expect(resolveDualWrite({ dualWrite: 1 as unknown as boolean })).toBe(false);
    });

    it('returns false for non-boolean truthy values (defensive — object)', () => {
      expect(
        resolveDualWrite({ dualWrite: { value: true } as unknown as boolean }),
      ).toBe(false);
    });

    it('ignores other co-stored fields (orthogonal to sourceOfTruth)', () => {
      // Per Decision 2 + 4: dualWrite is orthogonal to sourceOfTruth.
      // The resolver MUST NOT short-circuit based on sourceOfTruth.
      expect(
        resolveDualWrite({ dualWrite: true, sourceOfTruth: 'postgres' } as {
          dualWrite?: boolean;
        }),
      ).toBe(true);
      expect(
        resolveDualWrite({ dualWrite: true, sourceOfTruth: 'vault' } as {
          dualWrite?: boolean;
        }),
      ).toBe(true);
    });

    it('does NOT consult env vars (operator-set per campaign only)', () => {
      // Unlike resolveSourceOfTruth, there is NO env override for dualWrite.
      // An env-wide default would risk accidental global enablement of the
      // Promise.all([vault, postgres]) fan-out across every campaign.
      vi.stubEnv('DUAL_WRITE', 'true');
      vi.stubEnv('MASTER_DUAL_WRITE', 'true');
      try {
        expect(resolveDualWrite({})).toBe(false);
        expect(resolveDualWrite(undefined)).toBe(false);
        expect(resolveDualWrite({ dualWrite: false })).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('validateSettingsPatch — dualWrite arm', () => {
    it('accepts true', () => {
      const result = validateSettingsPatch({ dualWrite: true });
      expect(result).toEqual({ ok: true, patch: { dualWrite: true } });
    });

    it('accepts false', () => {
      const result = validateSettingsPatch({ dualWrite: false });
      expect(result).toEqual({ ok: true, patch: { dualWrite: false } });
    });

    it('accepts undefined (clear)', () => {
      const result = validateSettingsPatch({ dualWrite: undefined });
      expect(result).toEqual({ ok: true, patch: { dualWrite: undefined } });
    });

    it('accepts null (maps to undefined in the out shape)', () => {
      const bad = { dualWrite: null as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: true, patch: { dualWrite: undefined } });
    });

    it('rejects string "true"', () => {
      const bad = { dualWrite: 'true' as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-dualWrite' });
    });

    it('rejects number 1', () => {
      const bad = { dualWrite: 1 as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-dualWrite' });
    });

    it('rejects object', () => {
      const bad = { dualWrite: { value: true } as unknown as boolean };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-dualWrite' });
    });

    it('does not affect sibling arms (combined patch validates each)', () => {
      // The validator processes arms independently. Verify a combined
      // sourceOfTruth + dualWrite + cutoverAt patch round-trips intact.
      const result = validateSettingsPatch({
        sourceOfTruth: 'vault',
        dualWrite: true,
        cutoverAt: '2026-05-26T12:00:00Z',
      });
      expect(result).toEqual({
        ok: true,
        patch: {
          sourceOfTruth: 'vault',
          dualWrite: true,
          cutoverAt: '2026-05-26T12:00:00Z',
        },
      });
    });

    it('does not introduce the field when absent from body', () => {
      const result = validateSettingsPatch({ manualRolls: true });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.patch).not.toHaveProperty('dualWrite');
    });
  });

  describe('getCampaignSettings — dualWrite resolution', () => {
    beforeEach(() => {
      vi.stubEnv('MASTER_BACKEND', '');
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', '');
      vi.stubEnv('MASTER_PROVIDER', '');
      vi.stubEnv('IMAGE_PROVIDER', '');
      vi.stubEnv('TTS_PROVIDER', '');
      TEST_CAMPAIGN_SETTINGS = {};
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns false when stored is empty {} (Phase 02 default)', async () => {
      TEST_CAMPAIGN_SETTINGS = {};
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000001');
      expect(s.dualWrite).toBe(false);
    });

    it('returns true when stored {dualWrite:true}', async () => {
      TEST_CAMPAIGN_SETTINGS = { dualWrite: true };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000002');
      expect(s.dualWrite).toBe(true);
    });

    it('returns false when stored {dualWrite:false}', async () => {
      TEST_CAMPAIGN_SETTINGS = { dualWrite: false };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000003');
      expect(s.dualWrite).toBe(false);
    });

    it('returns true with sourceOfTruth=postgres + dualWrite=true (03-A coexistence)', async () => {
      // The 03-A migration state: dualWrite enabled, reads still on Postgres.
      // Decision 2 + 4: orthogonal flags. dualWrite MUST be true even when
      // sourceOfTruth is postgres.
      TEST_CAMPAIGN_SETTINGS = { sourceOfTruth: 'postgres', dualWrite: true };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000004');
      expect(s.dualWrite).toBe(true);
      expect(s.sourceOfTruth).toBe('postgres');
    });

    it('returns true with sourceOfTruth=vault + dualWrite=true (03-B post-cutover rollback safety)', async () => {
      // The 03-B cutover state: reads pivoted to vault, dualWrite still on
      // so Postgres stays in sync as a rollback target during the
      // CUTOVER_ROLLBACK_HOURS window.
      TEST_CAMPAIGN_SETTINGS = { sourceOfTruth: 'vault', dualWrite: true };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000005');
      expect(s.dualWrite).toBe(true);
      expect(s.sourceOfTruth).toBe('vault');
    });

    it('throws when the campaign row is missing', async () => {
      TEST_CAMPAIGN_SETTINGS = null;
      await expect(
        getCampaignSettings('00000000-0000-0000-0000-000000000099'),
      ).rejects.toThrow(/not found/);
    });
  });
});
