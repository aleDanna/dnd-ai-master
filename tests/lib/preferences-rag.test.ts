import { describe, it, expect } from 'vitest';
import { resolveUseRagRetrieval } from '@/lib/preferences';

describe('resolveUseRagRetrieval', () => {
  it('returns true when explicitly true', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: true })).toBe(true);
  });

  it('returns false when explicitly false', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: false })).toBe(false);
  });

  it('defaults to true when undefined (UI toggle removed; always-on policy)', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: undefined })).toBe(true);
    expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: undefined })).toBe(true);
  });
});
