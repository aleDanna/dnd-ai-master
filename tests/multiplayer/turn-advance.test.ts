import { describe, it, expect } from 'vitest';
import { computeTurnAdvance, detectAddressee } from '@/multiplayer/turn-advance';

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

  // Regression for the "OOC clarification stole the turn" bug: the master
  // replied to an out-of-character question with a brief explanation that
  // addressed nobody, and the previous round-robin fallback rotated the
  // active PG anyway. The fix: a silent master response keeps cpcId where
  // it was; round-robin is no longer a fallback.
  it('stays on the current PG when the master is silent (no addressee, no tool advance)', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: 'usopp',
      afterCpcId: 'usopp',
      party,
    });
    expect(result).toEqual({ kind: 'skip' });
  });

  it('seeds the active PG when both before and after are null (multi-character init)', () => {
    const result = computeTurnAdvance({
      isBegin: false,
      beforeCpcId: null,
      afterCpcId: null,
      party,
    });
    // First-beat seed: pick party[0] so the session has a starting active PG.
    // This is the ONLY case the route auto-advances without a master signal.
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
    // Bogus addressee falls through; with no other signals, cpcId stays.
    expect(result).toEqual({ kind: 'skip' });
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

  // The "Percezione" bug: master narrates a long POV section starting with
  // "Kank Reena, le parole di Bruce..." and ends with a generic action prompt
  // ("Tira una prova di Percezione.") — no closing addressee in the tail.
  // The old tail-only scan returned null and round-robin sent the roll to
  // the wrong PG. Scanning the whole message picks the POV-opening address.
  it('catches a POV-opening addressee even when the closing prompt is generic', () => {
    const text =
      `Kank Reena, le parole di Bruce Kettah risuonano in te come una melodia agrodolce di speranza e incertezza. "Questa per me potrebbe essere una grande speranza. Speravo fosse vivo, ma non ne sono sicura." Dici, la tua voce è un sussurro che quasi si perde nell'aria. Poi, con un moto di cautela, decidi di usare i tuoi sensi affinati. "Nel frattempo faccio una prova di percezione sulle due persone che mi sono accanto, per vedere se riesco a riconoscerne la provenienza."\n\nTira una prova di Percezione.`;
    const party = [
      { id: 'bruce-id', name: 'Bruce Kettah' },
      { id: 'kank-id', name: 'Kank Reena' },
    ];
    expect(detectAddressee(text, party)).toEqual({ id: 'kank-id' });
  });

  it('still prefers the LAST addressee when both opening and closing addresses are present', () => {
    const text = 'Bruce, le ombre si muovono attorno a te. Dopo un momento, ti volti.\n\nKank, cosa fai?';
    expect(detectAddressee(text, named)).toEqual({ id: 'kank-id' });
  });

  // The "first-name only" bug: party rows store full names ("Bruce Kettah",
  // "Kank Reena") but the master naturally drops to first names in dialog
  // ("Bruce, cosa rispondi?"). Without short-form support the closing
  // address misses and the server skips the turn switch.
  it('matches a short-form first name when the party uses full names', () => {
    const fullNamed = [
      { id: 'bruce-id', name: 'Bruce Kettah' },
      { id: 'kank-id', name: 'Kank Reena' },
    ];
    const text =
      'Kank Reena, stringi la pergamena.\n\nBruce Kettah ti guarda, la sua espressione riflessiva.\n\nBruce, Kank ti ha appena chiesto un parere. Cosa rispondi?';
    expect(detectAddressee(text, fullNamed)).toEqual({ id: 'bruce-id' });
  });

  it('matches a short-form last name when unambiguous', () => {
    const fullNamed = [
      { id: 'bruce-id', name: 'Bruce Kettah' },
      { id: 'kank-id', name: 'Kank Reena' },
    ];
    expect(detectAddressee('La storia continua. Kettah, sei pronto?', fullNamed)).toEqual({ id: 'bruce-id' });
  });

  it('drops ambiguous short forms when two PGs share a token (must use full name)', () => {
    // Two Bruces in the party → "Bruce," alone is ambiguous and excluded.
    // The master must use the disambiguating last name.
    const collidingParty = [
      { id: 'bruce-a', name: 'Bruce Kettah' },
      { id: 'bruce-b', name: 'Bruce Tarras' },
    ];
    // Short "Bruce," → dropped, no match.
    expect(detectAddressee('Le ombre si muovono. Bruce, cosa fai?', collidingParty)).toBeNull();
    // Full "Bruce Kettah," → routes correctly.
    expect(detectAddressee('Bruce Kettah, cosa fai?', collidingParty)).toEqual({ id: 'bruce-a' });
    // Unique last name still works ("Tarras" only belongs to bruce-b).
    expect(detectAddressee('Le ombre si muovono. Tarras, cosa fai?', collidingParty)).toEqual({ id: 'bruce-b' });
  });

  it('ignores name tokens shorter than 3 chars (so a "Bo" PG does not get spuriously matched)', () => {
    const shortNamed = [{ id: 'bo-id', name: 'Bo' }];
    // The 2-char name itself is still a full-name variant, but no token
    // pruning happens — the regex still anchors on sentence boundary + comma
    // so this single match is intentional.
    expect(detectAddressee('Cosa fai?\n\nBo, tocca a te.', shortNamed)).toEqual({ id: 'bo-id' });
    // But token-pruning DOES drop the 2-char first name of a multi-token PG.
    const partialNamed = [{ id: 'al-id', name: 'Al Ironheart' }];
    // "Al," alone (2 chars) is below the threshold → not added as a variant.
    expect(detectAddressee('Cosa fai?\n\nAl, tocca a te.', partialNamed)).toBeNull();
    // Full name and last name (≥ 3 chars) still match.
    expect(detectAddressee('Al Ironheart, tocca a te.', partialNamed)).toEqual({ id: 'al-id' });
    expect(detectAddressee('Cosa fai?\n\nIronheart, tocca a te.', partialNamed)).toEqual({ id: 'al-id' });
  });
});
