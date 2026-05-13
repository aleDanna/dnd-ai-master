import { describe, it, expect } from 'vitest';
import { computeTurnAdvance } from '@/multiplayer/turn-advance';

type Char = { id: string; createdAt: Date };
const party: Char[] = [
  { id: 'usopp', createdAt: new Date('2026-05-01T10:00:00Z') },
  { id: 'luffy', createdAt: new Date('2026-05-01T10:05:00Z') },
];

describe('computeTurnAdvance', () => {
  it('skips on begin turn even when cpcId did not change', () => {
    const result = computeTurnAdvance({
      isBegin: true,
      beforeCpcId: 'usopp',
      afterCpcId: 'usopp',
      party,
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('skips on a single-character party (solo / 1-player "multiplayer")', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'usopp',
      party: [party[0]!],
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('skips when the master successfully advanced to a different character', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'luffy',
      party,
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  // Regression for the screenshot bug: master narrated "Luffy, che fai?" but
  // the turn stayed on Usopp because Gemini either no-op'd set_current_player
  // (called it with Usopp's id) or had it rejected (passed "Luffy" instead of
  // the uuid). Both cases leave the DB state unchanged.
  it('advances round-robin when the master left cpcId on the same character', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'usopp',
      party,
    });
    expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
  });

  it('advances round-robin (wrapping) from the last party member back to the first', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'luffy',
      afterCpcId: 'luffy',
      party,
    });
    expect(result).toEqual({ kind: 'advance', nextCharacterId: 'usopp' });
  });

  it('advances when both before and after are null (cpcId never set, multi-character party)', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: null,
      afterCpcId: null,
      party,
    });
    // nextInParty('', party) returns party[0] — usopp here.
    expect(result).toEqual({ kind: 'advance', nextCharacterId: 'usopp' });
  });
});
