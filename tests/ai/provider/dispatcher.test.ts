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

  it('returns gemini for MASTER_PROVIDER=gemini', () => {
    process.env.MASTER_PROVIDER = 'gemini';
    expect(getMasterProvider().name).toBe('gemini');
  });

  it('throws for an unknown MASTER_PROVIDER value', () => {
    process.env.MASTER_PROVIDER = 'cohere';
    expect(() => getMasterProvider()).toThrow(/unknown MASTER_PROVIDER: cohere/);
  });
});
