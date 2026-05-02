import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMasterProvider, _resetMasterProviderForTests } from '@/ai/provider';

const ORIGINAL = process.env.MASTER_PROVIDER;

describe('getMasterProvider', () => {
  beforeEach(() => {
    _resetMasterProviderForTests();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MASTER_PROVIDER;
    else process.env.MASTER_PROVIDER = ORIGINAL;
    _resetMasterProviderForTests();
  });

  it('defaults to anthropic when MASTER_PROVIDER is unset', () => {
    delete process.env.MASTER_PROVIDER;
    expect(getMasterProvider().name).toBe('anthropic');
  });

  it('returns anthropic for MASTER_PROVIDER=anthropic', () => {
    process.env.MASTER_PROVIDER = 'anthropic';
    expect(getMasterProvider().name).toBe('anthropic');
  });

  it('returns openai for MASTER_PROVIDER=openai', () => {
    process.env.MASTER_PROVIDER = 'openai';
    expect(getMasterProvider().name).toBe('openai');
  });

  it('throws for an unknown MASTER_PROVIDER value', () => {
    process.env.MASTER_PROVIDER = 'gemini';
    expect(() => getMasterProvider()).toThrow(/unknown MASTER_PROVIDER: gemini/);
  });
});
