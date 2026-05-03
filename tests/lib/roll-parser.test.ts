import { describe, it, expect } from 'vitest';
import { parseRollRequests, rollFormula, normalizeFormula, detectGroupMode } from '@/lib/roll-parser';

describe('parseRollRequests', () => {
  it('catches a basic "Roll 1d20+5"', () => {
    const reqs = parseRollRequests('Roll 1d20+5 vs the goblin (AC 13).');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20+5');
    expect(reqs[0]!.kind).toBe('generic');
  });

  it('infers attack kind from surrounding text', () => {
    const reqs = parseRollRequests('You swing your blade. Roll 1d20+5 for an attack against the goblin.');
    expect(reqs[0]!.kind).toBe('attack');
  });

  it('infers damage kind', () => {
    const reqs = parseRollRequests('It hits! Roll 1d8+3 for damage.');
    expect(reqs[0]!.kind).toBe('damage');
  });

  it('parses a DC save', () => {
    const reqs = parseRollRequests('Roll a DC 14 Dexterity save.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.kind).toBe('save');
    expect(reqs[0]!.label).toBe('DEX save (DC 14)');
    expect(reqs[0]!.formula).toBe('1d20');
  });

  it('parses a skill check with DC', () => {
    const reqs = parseRollRequests('Roll a DC 15 Perception check.');
    expect(reqs[0]!.kind).toBe('check');
    expect(reqs[0]!.label).toBe('Perception check (DC 15)');
  });

  it('parses a skill check without DC', () => {
    const reqs = parseRollRequests('Roll a Perception check, please.');
    expect(reqs[0]!.kind).toBe('check');
    expect(reqs[0]!.label).toBe('Perception check');
  });

  it('catches multiple requests in the same message', () => {
    const reqs = parseRollRequests(
      'Roll 1d20+5 to attack. If you hit, roll 1d8+3 for damage.',
    );
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.kind).toBe('attack');
    expect(reqs[1]!.kind).toBe('damage');
  });

  // ─── Purpose extraction ───────────────────────────────────────────────────────

  it('extracts the Italian "per una prova di X" purpose', () => {
    const reqs = parseRollRequests('tira 1d20+2 per una prova di Sopravvivenza (CD 10).');
    expect(reqs[0]!.label).toBe('1d20+2 (Sopravvivenza)');
  });

  it('extracts purpose with a parenthetical sub-skill', () => {
    const reqs = parseRollRequests('tira 1d20 per una prova di Intelligenza (Investigazione) (CD 12).');
    expect(reqs[0]!.label).toBe('1d20 (Intelligenza)');
  });

  it('extracts purpose without "prova di"', () => {
    const reqs = parseRollRequests('tira 1d20+1 per Furtività; la confronterò con le percezioni passive.');
    expect(reqs[0]!.label).toBe('1d20+1 (Furtività)');
  });

  it('extracts English "for a X check"', () => {
    const reqs = parseRollRequests('Roll 1d20 for a Perception check.');
    expect(reqs[0]!.label).toBe('1d20 (Perception)');
  });

  it('extracts English damage', () => {
    const reqs = parseRollRequests('It hits! Roll 1d8+3 for damage.');
    expect(reqs[0]!.label).toBe('1d8+3 (damage)');
  });

  it('extracts all three purposes from a multi-option Italian message', () => {
    const reqs = parseRollRequests(
      'Vuoi: - Seguire le tracce subito: tira 1d20+2 per una prova di Sopravvivenza (CD 10). ' +
      '- Studiare la mappa: tira 1d20 per una prova di Intelligenza (Investigazione) (CD 12). ' +
      '- Avanzare di soppiatto: tira 1d20+1 per Furtività.',
    );
    expect(reqs.length).toBe(3);
    expect(reqs[0]!.label).toBe('1d20+2 (Sopravvivenza)');
    expect(reqs[1]!.label).toBe('1d20 (Intelligenza)');
    expect(reqs[2]!.label).toBe('1d20+1 (Furtività)');
  });

  it('falls back to bare formula when no purpose phrase follows', () => {
    const reqs = parseRollRequests('Roll 1d20+3.');
    expect(reqs[0]!.label).toBe('1d20+3');
  });

  it('rejects bogus formulas', () => {
    expect(normalizeFormula('1d7')).toBeNull(); // d7 isn't a real die
    expect(normalizeFormula('xd20')).toBeNull();
    expect(normalizeFormula('1d20+5')).toBe('1d20+5');
    expect(normalizeFormula('d20')).toBe('1d20');
    expect(normalizeFormula('2d6-1')).toBe('2d6-1');
  });
});

describe('detectGroupMode', () => {
  it('returns "or" for a single roll (mode is moot)', () => {
    expect(detectGroupMode('Roll 1d20+5.', 1)).toBe('or');
  });

  it('returns "and" by default for two unrelated rolls', () => {
    const text = 'Sei colpita dall\'esplosione. Tira un TS Destrezza CD 14 e poi un TS Costituzione CD 12.';
    expect(detectGroupMode(text, 2)).toBe('and');
  });

  it('returns "or" when the message starts with "Vuoi:" (Italian choice list)', () => {
    const text =
      'Vuoi: - Seguire le tracce: tira 1d20+2. - Studiare la mappa: tira 1d20.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "or" when the message starts with "Scegli:"', () => {
    expect(detectGroupMode('Scegli: tira 1d20 oppure tira 1d20+2.', 2)).toBe('or');
  });

  it('returns "or" when the message starts with "Choose:" (English choice list)', () => {
    expect(detectGroupMode('Choose: roll 1d20 or roll 1d20+2.', 2)).toBe('or');
  });

  it('returns "or" when the choice keyword is separated from the colon ("Scegli l\'approccio:")', () => {
    // Reproduces the screenshot scenario: master prefixes a multi-option block
    // with "Scegli l'approccio:" instead of bare "Scegli:".
    const text =
      'Vedi due vie d\'accesso. Scegli l\'approccio: ' +
      '- Insegui lungo la pista: tira 1d20+2 per Sopravvivenza. ' +
      '- Aggira dalla dorsale: tira 1d20+1 per Furtività.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "or" for "Choose the path:" (English, separated)', () => {
    const text = 'Choose the path: roll 1d20 for stealth or roll 1d20+2 for survival.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "or" for "Hai due opzioni davanti a te:"', () => {
    const text = 'Hai due opzioni davanti a te: tira 1d20 oppure tira 1d20+2.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "or" for "You have two options:"', () => {
    expect(detectGroupMode('You have two options: roll 1d20 or roll 1d20+2.', 2)).toBe('or');
  });

  it('returns "or" for "You may:" softer introducer', () => {
    expect(detectGroupMode('You may: roll 1d20 for athletics or roll 1d20+2 for stealth.', 2)).toBe('or');
  });

  it('does NOT trigger "or" when the choice keyword and colon are split by a sentence end', () => {
    // "Devi scegliere. Tira 1d20+5. Tira 1d8+3." — no colon-introduced list.
    const text = 'Devi scegliere. Tira 1d20+5 per attacco. Tira 1d8+3 per danni.';
    // No "if you hit" either, so this stays AND (default for 2+ rolls).
    expect(detectGroupMode(text, 2)).toBe('and');
  });

  it('returns "or" when the message says "You can:"', () => {
    expect(detectGroupMode('You can: roll 1d20 to attack or roll 1d20+3 for stealth.', 2)).toBe('or');
  });

  it('returns "or" for "either ... or" English idiom', () => {
    expect(
      detectGroupMode('You can either roll 1d20 for stealth or roll 1d20+2 for survival.', 2),
    ).toBe('or');
  });

  it('returns "or" for "oppure" Italian connector', () => {
    expect(detectGroupMode('Tira 1d20 per furtività oppure tira 1d20+2 per percezione.', 2)).toBe('or');
  });

  it('returns "or" for an English conditional second roll ("if you hit")', () => {
    const text = 'Roll 1d20+5 to attack. If you hit, roll 1d8+3 for damage.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "or" for "on a hit"', () => {
    expect(detectGroupMode('Roll 1d20+5 to attack. On a hit, roll 1d8+3 for damage.', 2)).toBe('or');
  });

  it('returns "or" for an Italian conditional second roll ("se colpisci")', () => {
    const text = 'Tira 1d20+5 per attaccare. Se colpisci, tira 1d8+3 per i danni.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "or" for "in caso di successo"', () => {
    const text = 'Tira 1d20+5 per attaccare. In caso di successo, tira 1d8+3 per i danni.';
    expect(detectGroupMode(text, 2)).toBe('or');
  });

  it('returns "and" for two simultaneous saves (no choice/conditional cue)', () => {
    const text = 'L\'esplosione ti investe. Tira un TS Destrezza CD 14 e un TS Costituzione CD 12.';
    expect(detectGroupMode(text, 2)).toBe('and');
  });
});

describe('parseRollRequests — group mode stamping', () => {
  it('stamps every request in a "Vuoi:" message as "or"', () => {
    const reqs = parseRollRequests(
      'Vuoi: - Seguire le tracce subito: tira 1d20+2 per una prova di Sopravvivenza (CD 10). ' +
        '- Studiare la mappa: tira 1d20 per una prova di Intelligenza (Investigazione) (CD 12). ' +
        '- Avanzare di soppiatto: tira 1d20+1 per Furtività.',
    );
    expect(reqs.length).toBe(3);
    expect(reqs.every((r) => r.groupMode === 'or')).toBe(true);
  });

  it('stamps two simultaneous saves as "and"', () => {
    const reqs = parseRollRequests(
      'L\'esplosione ti investe. Roll a DC 14 Dexterity save. Then roll a DC 12 Constitution save.',
    );
    expect(reqs.length).toBe(2);
    expect(reqs.every((r) => r.groupMode === 'and')).toBe(true);
  });

  it('stamps an attack-then-conditional-damage pair as "or"', () => {
    const reqs = parseRollRequests('Roll 1d20+5 to attack. If you hit, roll 1d8+3 for damage.');
    expect(reqs.length).toBe(2);
    expect(reqs.every((r) => r.groupMode === 'or')).toBe(true);
  });

  it('a single roll is always "or"', () => {
    const reqs = parseRollRequests('Roll 1d20+5 for your attack against the goblin.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.groupMode).toBe('or');
  });
});

describe('rollFormula', () => {
  it('rolls within the expected range with deterministic RNG', () => {
    // RNG = 0.99 → near-max
    const max = rollFormula('1d20+5', () => 0.99);
    expect(max.rolls[0]).toBe(20);
    expect(max.modifier).toBe(5);
    expect(max.total).toBe(25);

    // RNG = 0 → min
    const min = rollFormula('1d20+5', () => 0);
    expect(min.rolls[0]).toBe(1);
    expect(min.total).toBe(6);
  });

  it('handles multi-die formulas', () => {
    const r = rollFormula('2d6+3', () => 0.5);
    expect(r.rolls.length).toBe(2);
    expect(r.modifier).toBe(3);
    expect(r.total).toBe(r.rolls[0]! + r.rolls[1]! + 3);
  });

  it('handles formulas without modifier', () => {
    const r = rollFormula('1d8', () => 0.5);
    expect(r.modifier).toBe(0);
    expect(r.rolls[0]).toBe(5);
    expect(r.total).toBe(5);
  });
});
