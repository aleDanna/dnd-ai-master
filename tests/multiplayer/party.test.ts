import { describe, it, expect } from 'vitest';
import { nextInParty } from '@/multiplayer/party';

type Char = { id: string; createdAt: Date };
const party: Char[] = [
  { id: 'a', createdAt: new Date('2026-05-01T10:00:00Z') },
  { id: 'b', createdAt: new Date('2026-05-01T10:05:00Z') },
  { id: 'c', createdAt: new Date('2026-05-01T10:10:00Z') },
];

describe('nextInParty', () => {
  it('returns the next character in created-at order', () => {
    expect(nextInParty('a', party).id).toBe('b');
    expect(nextInParty('b', party).id).toBe('c');
  });
  it('wraps around at the end', () => {
    expect(nextInParty('c', party).id).toBe('a');
  });
  it('returns the first character when current is not in party', () => {
    expect(nextInParty('zzz', party).id).toBe('a');
  });
  it('returns the only character when party has one', () => {
    expect(nextInParty('solo', [{ id: 'solo', createdAt: new Date() }]).id).toBe('solo');
  });
  it('throws on empty party', () => {
    expect(() => nextInParty('a', [])).toThrow(/empty/);
  });
});
