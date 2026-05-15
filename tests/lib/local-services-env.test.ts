import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isLocalEnvironment } from '@/lib/local-services';

describe('isLocalEnvironment', () => {
  const original = { NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL };
  beforeEach(() => {
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'development';
  });
  afterEach(() => {
    process.env.NODE_ENV = original.NODE_ENV;
    if (original.VERCEL) process.env.VERCEL = original.VERCEL;
    else delete process.env.VERCEL;
  });

  it('returns true when NODE_ENV is development and no VERCEL', () => {
    expect(isLocalEnvironment()).toBe(true);
  });

  it('returns false when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns false when VERCEL=1', () => {
    process.env.VERCEL = '1';
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns false when VERCEL is set (any truthy)', () => {
    process.env.VERCEL = 'true';
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns true when NODE_ENV is test (vitest default) and no VERCEL', () => {
    process.env.NODE_ENV = 'test';
    expect(isLocalEnvironment()).toBe(true);
  });
});
