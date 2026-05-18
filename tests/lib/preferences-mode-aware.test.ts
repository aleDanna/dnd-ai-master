import { describe, it, expect, vi } from 'vitest';

// Mock db client to avoid Postgres requirement — resolveUseModeAwarePrompt is pure.
vi.mock('@/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

import { resolveUseModeAwarePrompt } from '@/lib/preferences';

describe('resolveUseModeAwarePrompt', () => {
  it('returns true when explicitly true', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'cloud', useModeAwarePrompt: true })).toBe(true);
  });

  it('returns false when explicitly false', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'local', useModeAwarePrompt: false })).toBe(false);
  });

  it('defaults to true when undefined, regardless of provider (UI toggle removed)', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'local', useModeAwarePrompt: undefined })).toBe(true);
    expect(resolveUseModeAwarePrompt({ aiProvider: 'cloud', useModeAwarePrompt: undefined })).toBe(true);
  });
});
