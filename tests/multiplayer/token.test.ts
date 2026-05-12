import { describe, it, expect } from 'vitest';
import { generateInviteToken, isInviteValid } from '@/multiplayer/token';

describe('generateInviteToken', () => {
  it('returns a 12-char URL-safe string', () => {
    const t = generateInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
  it('produces unique tokens across calls', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateInviteToken()));
    expect(set.size).toBe(100);
  });
});

describe('isInviteValid', () => {
  const base = { revokedAt: null, expiresAt: null, maxUses: null, usesCount: 0 };
  const now = new Date('2026-05-12T12:00:00Z');

  it('accepts an active unbounded invite', () => {
    expect(isInviteValid(base, now)).toBe(true);
  });
  it('rejects a revoked invite', () => {
    expect(isInviteValid({ ...base, revokedAt: new Date('2026-05-11T00:00:00Z') }, now)).toBe(false);
  });
  it('rejects an expired invite', () => {
    expect(isInviteValid({ ...base, expiresAt: new Date('2026-05-11T00:00:00Z') }, now)).toBe(false);
  });
  it('accepts an invite expiring in the future', () => {
    expect(isInviteValid({ ...base, expiresAt: new Date('2026-05-13T00:00:00Z') }, now)).toBe(true);
  });
  it('rejects a maxed-out invite', () => {
    expect(isInviteValid({ ...base, maxUses: 5, usesCount: 5 }, now)).toBe(false);
  });
  it('accepts an invite below max uses', () => {
    expect(isInviteValid({ ...base, maxUses: 5, usesCount: 3 }, now)).toBe(true);
  });
});
