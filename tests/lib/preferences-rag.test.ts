import { describe, it, expect } from 'vitest';
import { resolveUseRagRetrieval } from '@/lib/preferences';

describe('resolveUseRagRetrieval', () => {
  it('returns true when explicitly true', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: true })).toBe(true);
  });

  it('returns false when explicitly false', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: false })).toBe(false);
  });

  it('defaults to false when undefined (Phase 2 - opt-in until Phase 3 flips it)', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: undefined })).toBe(false);
    expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: undefined })).toBe(false);
  });
});
