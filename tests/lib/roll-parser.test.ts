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
    // Two rolls at once for two simultaneous skill checks (no attack/damage
    // pair, so the safety-net filter doesn't fire).
    const reqs = parseRollRequests(
      'Roll 1d20+2 for a Perception check. Also, roll 1d20+3 for an Insight check.',
    );
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.kind).toBe('check');
    expect(reqs[1]!.kind).toBe('check');
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

  // ─── Tagged formula ("Tira iniziativa: 1d20+1") ─────────────────────────────

  it('parses "Tira iniziativa: 1d20+1" with purpose label', () => {
    // Reproduces the screenshot scenario verbatim.
    const reqs = parseRollRequests(
      'Niente sorpresa: si voltano tutti verso di te. Tira iniziativa: 1d20+1.',
    );
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20+1');
    expect(reqs[0]!.label).toBe('1d20+1 (iniziativa)');
    expect(reqs[0]!.kind).toBe('init');
  });

  it('parses "Roll initiative: 1d20+2" (English tagged form)', () => {
    const reqs = parseRollRequests('Roll initiative: 1d20+2.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20+2');
    expect(reqs[0]!.label).toBe('1d20+2 (initiative)');
    expect(reqs[0]!.kind).toBe('init');
  });

  it('parses "Tira l\'iniziativa: 1d20+1" stripping the article', () => {
    const reqs = parseRollRequests('Tira l\'iniziativa: 1d20+1.');
    expect(reqs[0]!.label).toBe('1d20+1 (iniziativa)');
  });

  it('parses "Tira attacco: 1d20+5" without a "for" phrase', () => {
    const reqs = parseRollRequests('Tira attacco: 1d20+5.');
    expect(reqs[0]!.label).toBe('1d20+5 (attacco)');
  });

  it('does not double-parse a formula that matches both bare and tagged forms', () => {
    // "Tira 1d20+5" matches bareRe (no colon, no tag); taggedRe should not
    // also match because there's no descriptor before a colon.
    const reqs = parseRollRequests('Tira 1d20+5 per attaccare.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('1d20+5 (attaccare)');
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

  it('a "Choose:" message of skill checks all gets "or"', () => {
    const reqs = parseRollRequests(
      'Choose: roll 1d20+2 for a Perception check or roll 1d20+1 for an Investigation check.',
    );
    expect(reqs.length).toBe(2);
    expect(reqs.every((r) => r.groupMode === 'or')).toBe(true);
  });

  it('a single roll is always "or"', () => {
    const reqs = parseRollRequests('Roll 1d20+5 for your attack against the goblin.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.groupMode).toBe('or');
  });
});

describe('parseRollRequests — attack/damage split safety net', () => {
  it('drops a damage roll when an attack roll is in the same message', () => {
    // The master broke the "two-turn" rule. We render only the attack button.
    const reqs = parseRollRequests(
      'Roll 1d20+5 to attack the goblin. If you hit, roll 1d8+3 for damage.',
    );
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20+5');
    expect(reqs[0]!.kind).toBe('attack');
  });

  it('drops Italian damage rolls when paired with attack rolls', () => {
    // Reproduces the screenshot scenario: 3 options, each with attack + damage.
    // Only the 3 attack buttons should survive.
    const reqs = parseRollRequests(
      'Vuoi: ' +
        '- Caricare il fuggitivo: tira 1d20+4 per attaccare. Se colpisci, tira 1d8+2 danni taglienti. ' +
        '- Scattare sulla sentinella: tira 1d20+4 per attaccare. Se colpisci, tira 1d8+2 danni taglienti. ' +
        '- Imbracciare l\'arco: tira 1d20+3 per l\'attacco con l\'arco corto. Se colpisci, tira 1d6+1 danni perforanti.',
    );
    expect(reqs.length).toBe(3);
    expect(reqs.every((r) => r.kind === 'attack')).toBe(true);
    // The three attack formulas appear in narrative order.
    expect(reqs[0]!.formula).toBe('1d20+4');
    expect(reqs[1]!.formula).toBe('1d20+4');
    expect(reqs[2]!.formula).toBe('1d20+3');
  });

  it('keeps damage rolls when there is NO attack roll in the message (e.g. environmental)', () => {
    // The trap deals damage automatically — there's nothing to gate it on,
    // so the player should still be able to roll the damage.
    const reqs = parseRollRequests('La trappola scatta. Tira 2d6 per i danni da fuoco.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('2d6');
    expect(reqs[0]!.kind).toBe('damage');
  });

  it('keeps damage rolls when paired with skill checks (no attack)', () => {
    // Contrived but not impossible: a skill check that's unrelated to a
    // damage roll. The filter only fires when an ATTACK roll is present.
    const reqs = parseRollRequests(
      'Roll 1d20+3 for an Athletics check to hold the rope. Also, roll 1d6 for damage from the burning splinters.',
    );
    expect(reqs.length).toBe(2);
  });

  it('group mode after filtering reflects the surviving rolls only', () => {
    // After dropping the conditional damage roll, only one roll survives.
    // A 1-roll message should be classified as 'or' (mode is moot).
    const reqs = parseRollRequests(
      'Roll 1d20+5 to attack the goblin. If you hit, roll 1d8+3 for damage.',
    );
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
