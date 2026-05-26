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
  resolveSourceOfTruth,
  validateSettingsPatch,
  isSourceOfTruth,
  getCampaignSettings,
  type SourceOfTruth,
} from '@/lib/preferences';

describe('sourceOfTruth flag (Phase 03-B — Decision 4)', () => {
  describe('isSourceOfTruth type guard', () => {
    it.each<[unknown, boolean]>([
      ['postgres', true],
      ['vault', true],
      ['POSTGRES', false],
      ['VAULT', false],
      ['Vault', false],
      ['baked', false],
      ['mysql', false],
      ['', false],
      [null, false],
      [undefined, false],
      [123, false],
      [true, false],
      [{}, false],
      [[], false],
    ])('isSourceOfTruth(%j) === %j', (input, expected) => {
      expect(isSourceOfTruth(input)).toBe(expected);
    });
  });

  describe('resolveSourceOfTruth — env override + stored-wins semantics', () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('defaults to postgres when no stored value and no env override', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', '');
      expect(resolveSourceOfTruth(undefined)).toBe('postgres');
    });

    it('returns the env override when no stored value (vault)', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'vault');
      expect(resolveSourceOfTruth(undefined)).toBe('vault');
    });

    it('returns postgres when env override is the literal "postgres"', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'postgres');
      expect(resolveSourceOfTruth(undefined)).toBe('postgres');
    });

    it('stored value wins over env override (vault env → postgres stored)', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'vault');
      expect(resolveSourceOfTruth('postgres')).toBe('postgres');
    });

    it('stored value wins over env override (postgres env → vault stored)', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'postgres');
      expect(resolveSourceOfTruth('vault')).toBe('vault');
    });

    it('falls back to postgres when env override is invalid', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'sqlite');
      expect(resolveSourceOfTruth(undefined)).toBe('postgres');
    });

    it('normalizes env override case + whitespace', () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', '  VAULT  ');
      expect(resolveSourceOfTruth(undefined)).toBe('vault');
    });
  });

  describe('validateSettingsPatch — sourceOfTruth arm', () => {
    it('accepts postgres', () => {
      const result = validateSettingsPatch({ sourceOfTruth: 'postgres' });
      expect(result).toEqual({ ok: true, patch: { sourceOfTruth: 'postgres' } });
    });

    it('accepts vault', () => {
      const result = validateSettingsPatch({ sourceOfTruth: 'vault' });
      expect(result).toEqual({ ok: true, patch: { sourceOfTruth: 'vault' } });
    });

    it('rejects an invalid value', () => {
      const bad = { sourceOfTruth: 'sqlite' as unknown as SourceOfTruth };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-sourceOfTruth' });
    });

    it('rejects uppercase variants (strict equality)', () => {
      const bad = { sourceOfTruth: 'VAULT' as unknown as SourceOfTruth };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-sourceOfTruth' });
    });

    it('rejects number', () => {
      const bad = { sourceOfTruth: 1 as unknown as SourceOfTruth };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-sourceOfTruth' });
    });

    it('accepts undefined-clear (lets operator reset the field)', () => {
      const result = validateSettingsPatch({ sourceOfTruth: undefined });
      expect(result).toEqual({ ok: true, patch: { sourceOfTruth: undefined } });
    });

    it('accepts null-clear (maps to undefined in the out shape)', () => {
      // null is a valid clear sentinel (matches the masterBackend/vaultMutations
      // arms — JSON serialisation can send null for "unset").
      const bad = { sourceOfTruth: null as unknown as SourceOfTruth };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: true, patch: { sourceOfTruth: undefined } });
    });

    it('does not introduce the field when absent from body', () => {
      const result = validateSettingsPatch({ manualRolls: true });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.patch).not.toHaveProperty('sourceOfTruth');
    });
  });

  describe('validateSettingsPatch — cutoverAt arm (paired with sourceOfTruth)', () => {
    it('accepts a valid ISO-8601 timestamp', () => {
      const result = validateSettingsPatch({ cutoverAt: '2026-05-26T12:00:00Z' });
      expect(result).toEqual({ ok: true, patch: { cutoverAt: '2026-05-26T12:00:00Z' } });
    });

    it('accepts a valid ISO-8601 timestamp with timezone offset', () => {
      const result = validateSettingsPatch({ cutoverAt: '2026-05-26T14:30:00+02:00' });
      expect(result).toEqual({
        ok: true,
        patch: { cutoverAt: '2026-05-26T14:30:00+02:00' },
      });
    });

    it('rejects garbage strings', () => {
      const result = validateSettingsPatch({ cutoverAt: 'invalid-date' });
      expect(result).toEqual({ ok: false, error: 'invalid-cutoverAt' });
    });

    it('rejects non-string values', () => {
      const bad = { cutoverAt: 12345 as unknown as string };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: false, error: 'invalid-cutoverAt' });
    });

    it('accepts undefined-clear', () => {
      const result = validateSettingsPatch({ cutoverAt: undefined });
      expect(result).toEqual({ ok: true, patch: { cutoverAt: undefined } });
    });

    it('accepts null-clear', () => {
      const bad = { cutoverAt: null as unknown as string };
      const result = validateSettingsPatch(bad);
      expect(result).toEqual({ ok: true, patch: { cutoverAt: undefined } });
    });
  });

  describe('getCampaignSettings — sourceOfTruth resolution', () => {
    beforeEach(() => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', '');
      vi.stubEnv('MASTER_BACKEND', '');
      vi.stubEnv('MASTER_PROVIDER', '');
      vi.stubEnv('IMAGE_PROVIDER', '');
      vi.stubEnv('TTS_PROVIDER', '');
      TEST_CAMPAIGN_SETTINGS = {};
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns postgres for an empty settings object (default backward-compat)', async () => {
      TEST_CAMPAIGN_SETTINGS = {};
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000001');
      expect(s.sourceOfTruth).toBe('postgres');
    });

    it('returns vault when stored {sourceOfTruth:vault}', async () => {
      TEST_CAMPAIGN_SETTINGS = { sourceOfTruth: 'vault' };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000002');
      expect(s.sourceOfTruth).toBe('vault');
    });

    it('returns postgres when stored {sourceOfTruth:postgres}', async () => {
      TEST_CAMPAIGN_SETTINGS = { sourceOfTruth: 'postgres' };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000003');
      expect(s.sourceOfTruth).toBe('postgres');
    });

    it('returns vault when env MASTER_SOURCE_OF_TRUTH=vault and no stored value', async () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'vault');
      TEST_CAMPAIGN_SETTINGS = {};
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000004');
      expect(s.sourceOfTruth).toBe('vault');
    });

    it('stored postgres wins over env vault', async () => {
      vi.stubEnv('MASTER_SOURCE_OF_TRUTH', 'vault');
      TEST_CAMPAIGN_SETTINGS = { sourceOfTruth: 'postgres' };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000005');
      expect(s.sourceOfTruth).toBe('postgres');
    });

    it('passes cutoverAt through verbatim', async () => {
      TEST_CAMPAIGN_SETTINGS = {
        sourceOfTruth: 'vault',
        cutoverAt: '2026-05-26T20:00:00Z',
      };
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000006');
      expect(s.cutoverAt).toBe('2026-05-26T20:00:00Z');
    });

    it('returns empty string cutoverAt by default (never flipped)', async () => {
      TEST_CAMPAIGN_SETTINGS = {};
      const s = await getCampaignSettings('00000000-0000-0000-0000-000000000007');
      expect(s.cutoverAt).toBe('');
    });

    it('throws when the campaign row is missing', async () => {
      TEST_CAMPAIGN_SETTINGS = null;
      await expect(
        getCampaignSettings('00000000-0000-0000-0000-000000000099'),
      ).rejects.toThrow(/not found/);
    });
  });
});
