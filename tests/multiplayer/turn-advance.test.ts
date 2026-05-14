import { describe, it, expect } from 'vitest';
import {
  computeTurnAdvance,
  detectAddressee,
  MAX_CONSECUTIVE_BEATS_ON_SAME_PG,
} from '@/multiplayer/turn-advance';

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

  // The screenshot bug: master prose ends with "Kank, cosa fai?" while the
  // tool layer never moved cpcId off Bruce. Round-robin alone may rotate
  // to the wrong PG (alphabetical / creation-order next). The addressee
  // signal overrides round-robin and matches cpcId to the prose.
  it('advances to the addressed PG even when master forgot set_current_player', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'usopp',
      party,
      addresseeId: 'luffy',
    });
    expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
  });

  it('addressee overrides a wrong set_current_player tool call', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      // Master moved cpcId to itself (no-op) but prose addresses Luffy.
      // Trust the prose over the broken tool call.
      afterCpcId: 'usopp',
      party,
      addresseeId: 'luffy',
    });
    expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
  });

  it('skips when addressee matches cpcId (prose and tool agree)', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'luffy',
      party,
      addresseeId: 'luffy',
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('ignores addressee not in the party (defensive against bad prose match)', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'usopp',
      party,
      addresseeId: 'someone-else',
    });
    // Falls through to round-robin since the addressee is bogus.
    expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
  });

  // Fairness fallback: when the master keeps addressing the same PG over and
  // over without handing off, the system force-rotates after the streak hits
  // MAX_CONSECUTIVE_BEATS_ON_SAME_PG. Without this, one player monopolises
  // the spotlight (see the "Bruce-as-protagonist, Kank-as-bystander" bug).
  describe('fairness fallback', () => {
    it('allows the same PG to stay active under the streak threshold', () => {
      const result = computeTurnAdvance({
        isBegin: false,
        beforeCpcId: 'usopp',
        afterCpcId: 'usopp',
        party,
        addresseeId: 'usopp',
        consecutiveBeatsOnCurrent: MAX_CONSECUTIVE_BEATS_ON_SAME_PG - 1,
      });
      // Streak below threshold + prose addresses the same PG → legitimate
      // follow-up beat, do not interfere.
      expect(result).toEqual({ kind: 'skip' });
    });

    it('force-rotates when the master keeps spotlight at the streak threshold', () => {
      const result = computeTurnAdvance({
        isBegin: false,
        beforeCpcId: 'usopp',
        afterCpcId: 'usopp',
        party,
        addresseeId: 'usopp',
        consecutiveBeatsOnCurrent: MAX_CONSECUTIVE_BEATS_ON_SAME_PG,
      });
      expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
    });

    it('force-rotates even when prose has no addressee (silent spotlight hold)', () => {
      const result = computeTurnAdvance({
        isBegin: false,
        beforeCpcId: 'usopp',
        afterCpcId: 'usopp',
        party,
        addresseeId: null,
        consecutiveBeatsOnCurrent: MAX_CONSECUTIVE_BEATS_ON_SAME_PG,
      });
      expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
    });

    it('does NOT force-rotate when the master hands off via prose (addressee != current)', () => {
      // Streak is high but the master IS handing off to luffy — respect that
      // signal instead of overriding with a round-robin pick (which would be
      // luffy anyway here, but the principle holds for >2-PG parties).
      const result = computeTurnAdvance({
        isBegin: false,
        beforeCpcId: 'usopp',
        afterCpcId: 'usopp',
        party,
        addresseeId: 'luffy',
        consecutiveBeatsOnCurrent: MAX_CONSECUTIVE_BEATS_ON_SAME_PG,
      });
      expect(result).toEqual({ kind: 'advance', nextCharacterId: 'luffy' });
    });

    it('does NOT force-rotate when the master hands off via tool (cpcId moved)', () => {
      const result = computeTurnAdvance({
        isBegin: false,
        beforeCpcId: 'usopp',
        afterCpcId: 'luffy',
        party,
        consecutiveBeatsOnCurrent: MAX_CONSECUTIVE_BEATS_ON_SAME_PG,
      });
      // Master already moved cpcId via the tool — the streak counter is stale
      // on the route side and will be reset to 0 in the same transaction.
      expect(result).toEqual({ kind: 'skip' });
    });

    it('does NOT force-rotate in a solo / 1-PG party regardless of streak', () => {
      const result = computeTurnAdvance({
        isBegin: false,
        beforeCpcId: 'usopp',
        afterCpcId: 'usopp',
        party: [party[0]!],
        addresseeId: 'usopp',
        consecutiveBeatsOnCurrent: 99,
      });
      expect(result).toEqual({ kind: 'skip' });
    });
  });
});

describe('detectAddressee', () => {
  const named = [
    { id: 'bruce-id', name: 'Bruce' },
    { id: 'kank-id', name: 'Kank' },
  ];

  it('returns the last comma-addressed PG in the tail', () => {
    const text =
      "Bruce, il tuo sguardo è teso, in attesa di una reazione più chiara dal 'Cercatore'.\n\nKank, cosa fai?";
    expect(detectAddressee(text, named)).toEqual({ id: 'kank-id' });
  });

  it('catches an addressee at the very start of the message', () => {
    const text = 'Bruce, the door creaks open. What do you do?';
    expect(detectAddressee(text, named)).toEqual({ id: 'bruce-id' });
  });

  it('returns null when no party name is followed by a comma at a sentence boundary', () => {
    const text = 'The merchant nods at Bruce. Kank watches from the door.';
    expect(detectAddressee(text, named)).toBeNull();
  });

  it('ignores bare mentions inside narrative prose', () => {
    const text = 'You see Bruce slumped against the wall. The hall is silent.';
    expect(detectAddressee(text, named)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(detectAddressee('', named)).toBeNull();
    expect(detectAddressee('hello', [])).toBeNull();
  });

  it('handles English action prompts', () => {
    const text = 'A wind sweeps the chamber. Kank, what do you do?';
    expect(detectAddressee(text, named)).toEqual({ id: 'kank-id' });
  });

  it('handles names with special regex chars defensively (escaping)', () => {
    const party = [{ id: 'x', name: 'O.G. the Brave' }];
    const text = 'The fog parts. O.G. the Brave, your move.';
    expect(detectAddressee(text, party)).toEqual({ id: 'x' });
  });
});
