import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isLocalEnvironment } from '@/lib/local-services';

describe('isLocalEnvironment', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true when NODE_ENV is development and no VERCEL', () => {
    expect(isLocalEnvironment()).toBe(true);
  });

  it('returns false when NODE_ENV is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns false when VERCEL=1', () => {
    vi.stubEnv('VERCEL', '1');
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns false when VERCEL is set (any truthy)', () => {
    vi.stubEnv('VERCEL', 'true');
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns true when NODE_ENV is test (vitest default) and no VERCEL', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(isLocalEnvironment()).toBe(true);
  });
});
