import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveMasterBackend,
  validateSettingsPatch,
  isMasterBackend,
  type MasterBackend,
} from '@/lib/preferences';

describe('resolveMasterBackend (Phase 01 vault-llm-wiki feature flag)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to baked when no stored value and no env override', () => {
    vi.stubEnv('MASTER_BACKEND', '');
    expect(resolveMasterBackend(undefined)).toBe('baked');
  });

  it('returns the env override when no stored value', () => {
    vi.stubEnv('MASTER_BACKEND', 'vault');
    expect(resolveMasterBackend(undefined)).toBe('vault');
  });

  it('returns baked when env override is the literal "baked"', () => {
    vi.stubEnv('MASTER_BACKEND', 'baked');
    expect(resolveMasterBackend(undefined)).toBe('baked');
  });

  it('stored value wins over env override (vault → baked)', () => {
    vi.stubEnv('MASTER_BACKEND', 'vault');
    expect(resolveMasterBackend('baked')).toBe('baked');
  });

  it('stored value wins over env override (baked → vault)', () => {
    vi.stubEnv('MASTER_BACKEND', 'baked');
    expect(resolveMasterBackend('vault')).toBe('vault');
  });

  it('falls back to baked when env override is invalid', () => {
    vi.stubEnv('MASTER_BACKEND', 'turbo');
    expect(resolveMasterBackend(undefined)).toBe('baked');
  });

  it('normalizes env override case', () => {
    vi.stubEnv('MASTER_BACKEND', '  VAULT  ');
    expect(resolveMasterBackend(undefined)).toBe('vault');
  });
});

describe('isMasterBackend type guard', () => {
  it.each<[unknown, boolean]>([
    ['vault', true],
    ['baked', true],
    ['VAULT', false],
    ['vauLT', false],
    [null, false],
    [undefined, false],
    [123, false],
    [true, false],
    [{}, false],
    [[], false],
  ])('isMasterBackend(%j) === %j', (input, expected) => {
    expect(isMasterBackend(input)).toBe(expected);
  });
});

describe('validateSettingsPatch — masterBackend arm', () => {
  it('accepts vault', () => {
    const result = validateSettingsPatch({ masterBackend: 'vault' });
    expect(result).toEqual({ ok: true, patch: { masterBackend: 'vault' } });
  });

  it('accepts baked', () => {
    const result = validateSettingsPatch({ masterBackend: 'baked' });
    expect(result).toEqual({ ok: true, patch: { masterBackend: 'baked' } });
  });

  it('rejects an invalid value', () => {
    // Test the validator's runtime check: explicitly cast so the test
    // compiles, but the runtime branch is what we want to verify.
    const bad = { masterBackend: 'turbo' as unknown as MasterBackend };
    const result = validateSettingsPatch(bad);
    expect(result).toEqual({ ok: false, error: 'invalid-masterBackend' });
  });

  it('accepts undefined-clear (lets user reset the field)', () => {
    const result = validateSettingsPatch({ masterBackend: undefined });
    expect(result).toEqual({ ok: true, patch: { masterBackend: undefined } });
  });

  it('does not introduce the field when absent from body', () => {
    const result = validateSettingsPatch({ manualRolls: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch).not.toHaveProperty('masterBackend');
  });
});
