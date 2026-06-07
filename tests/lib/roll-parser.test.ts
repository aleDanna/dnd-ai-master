import { describe, it, expect } from 'vitest';
import {
  parseRollRequests,
  rollFormula,
  normalizeFormula,
  detectGroupMode,
  bulletIndexAt,
  pickAutoRoll,
} from '@/lib/roll-parser';

describe('parseRollRequests', () => {
  it('catches a basic "Roll 1d20+5"', () => {
    const reqs = parseRollRequests('Roll 1d20+5 vs the goblin (AC 13).');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20+5');
    expect(reqs[0]!.kind).toBe('generic');
  });

  it('parses a quote-wrapped Italian attack formula (model copies the quoted example)', () => {
    // The combat directive + rolls-block examples are quoted: "Tira 1d20+<bonus>...".
    // Local models copy the quotes verbatim, so the parser must tolerate a
    // leading quote char before the verb (regression: bottone 🎲 non comparendo).
    const reqs = parseRollRequests('Ma prima che tu possa toccarla, il mondo si piega.\n\n"Tira 1d20+3 per attaccare Veyra."');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20+3');
    expect(reqs[0]!.kind).toBe('attack');
  });

  it('tolerates curly/guillemet quotes before the verb', () => {
    expect(parseRollRequests('“Tira 1d20+2 per colpire.”').length).toBe(1);
    expect(parseRollRequests('«Roll 1d20+4 to attack»').length).toBe(1);
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

describe('parseRollRequests — Italian skill checks (no explicit formula)', () => {
  it('parses "tira una prova di Intimidazione CD 12" as a check button', () => {
    const reqs = parseRollRequests('Tira una prova di Intimidazione CD 12.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.label).toBe('Intimidazione (CD 12)');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses "tira una prova di Sopravvivenza" without DC', () => {
    const reqs = parseRollRequests('Tira una prova di Sopravvivenza.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('Sopravvivenza');
  });

  it('parses "fai una prova di Percezione (CD 15)" with parenthetical DC', () => {
    const reqs = parseRollRequests('Fai una prova di Percezione (CD 15).');
    expect(reqs[0]!.label).toBe('Percezione (CD 15)');
  });

  it('parses an ability-based prova ("prova di Forza CD 10")', () => {
    const reqs = parseRollRequests('Tira una prova di Forza CD 10.');
    expect(reqs[0]!.label).toBe('Forza (CD 10)');
  });

  it('handles the screenshot scenario verbatim — bullet 3 of a "Vuoi:" list', () => {
    const text =
      'Tocca a te. Vuoi:\n' +
      '- Scoccare una freccia al fuggitivo in fuga: tira 1d20+3 per attaccare il fuggitivo (CA 14 con mezza copertura).\n' +
      '- Inseguirlo a tutta velocità con una Corsa (Dash): nessun tiro.\n' +
      '- Fermarlo a voce con un urlo minaccioso: tira una prova di Intimidazione CD 12.';
    const reqs = parseRollRequests(text);
    // Two roll-able options: the attack and the intimidation check.
    expect(reqs.length).toBe(2);
    // Order matches narrative order.
    expect(reqs[0]!.formula).toBe('1d20+3');
    expect(reqs[0]!.kind).toBe('attack');
    expect(reqs[1]!.formula).toBe('1d20');
    expect(reqs[1]!.kind).toBe('check');
    expect(reqs[1]!.label).toContain('Intimidazione');
    expect(reqs[1]!.label).toContain('CD 12');
  });

  it('normalises "tira una prova di Intimidire" to canonical "Intimidazione"', () => {
    const reqs = parseRollRequests('Tira una prova di Intimidire CD 12.');
    expect(reqs[0]!.label).toBe('Intimidazione (CD 12)');
  });

  it('parses hybrid-language "Roll una prova di Intimidazione" as a check button', () => {
    // Reproduces a real bug: the master sometimes mixes English ("Roll") with
    // Italian skill-check syntax. Without explicit tolerance neither the
    // English nor the Italian pattern matches and no button appears.
    const reqs = parseRollRequests('Roll una prova di Intimidazione.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.label).toBe('Intimidazione');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses "Tenta una prova di Persuasione" as a check button', () => {
    // Reproduces a real bug from a session screenshot: master narrated
    // "Tenta una prova di Persuasione." but no roll button rendered
    // because the parser only knew Tira/Fai/Effettua/Lancia/Roll.
    // "Tenta" ("Attempt") is a natural imperative for a check in Italian
    // and the parser must accept it.
    const reqs = parseRollRequests('Tenta una prova di Persuasione.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.label).toBe('Persuasione');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses "Esegui una prova di Atletica CD 15" as a check button', () => {
    // "Esegui" ("Execute/Perform") is another imperative the master can
    // pick when varying prose; the parser must tolerate it alongside the
    // canonical Tira/Fai/Effettua.
    const reqs = parseRollRequests('Esegui una prova di Atletica CD 15.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('Atletica (CD 15)');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses "Compi una prova di Furtività" as a check button', () => {
    // "Compi" ("Perform/Accomplish") completes the small family of
    // imperative variants the parser accepts in addition to the canonical
    // verbs.
    const reqs = parseRollRequests('Compi una prova di Furtività.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('Furtività');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses a TRUNCATED/misspelled skill name as a check button (generic fallback)', () => {
    // Operator report: gemma wrote "Tira una prova di Furtiva" (dropped the "tà"
    // of "Furtività") → the in-list pattern missed it → NO button. The generic
    // fallback must still produce a 1d20 check; the alias normalizes the label.
    const reqs = parseRollRequests('Tira una prova di Furtiva.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.kind).toBe('check');
    expect(reqs[0]!.label).toBe('Furtività');
  });

  it('gives a check button for an out-of-list skill name (label kept verbatim)', () => {
    const reqs = parseRollRequests('Fai una prova di Equilibrismo.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.kind).toBe('check');
    expect(reqs[0]!.label).toBe('Equilibrismo');
  });

  it('does NOT double-count a known skill (specific + generic dedupe)', () => {
    const reqs = parseRollRequests('Tira una prova di Percezione CD 12.');
    expect(reqs.length).toBe(1);
  });

  it('parses "Tenta un TS Destrezza CD 14" as a save button', () => {
    // The same imperative tolerance applies to saving throws: the master
    // sometimes writes "Tenta un TS ..." instead of "Tira un TS ...".
    const reqs = parseRollRequests('Tenta un TS Destrezza CD 14.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('TS DES (CD 14)');
    expect(reqs[0]!.kind).toBe('save');
  });

  it('parses hybrid-language "Roll un TS Destrezza CD 14" as a save button', () => {
    const reqs = parseRollRequests('Roll un TS Destrezza CD 14.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.label).toBe('TS DES (CD 14)');
    expect(reqs[0]!.kind).toBe('save');
  });

  it('parses "tira una prova di Intuizione CD 12" (Insight alias)', () => {
    // Reproduces the user's screenshot: master narrates an Insight check
    // using "Intuizione" rather than the canonical "Intuito". Both are
    // valid Italian translations of D&D 5e Insight; the parser must
    // accept either and produce a button.
    const text =
      'Vuoi capire se scapperebbe se lo slegassi. Tira una prova di Intuizione CD 12.';
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    // Normalised to canonical "Intuito" in the label.
    expect(reqs[0]!.label).toBe('Intuito (CD 12)');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses "tira una prova di Intuito CD 14" (canonical form still works)', () => {
    const reqs = parseRollRequests('Tira una prova di Intuito CD 14.');
    expect(reqs[0]!.label).toBe('Intuito (CD 14)');
  });

  it('parses "tira una prova di Arcana" (Arcano alias)', () => {
    // User report: master narrated "Tira una prova di Arcana." for an
    // arcane-knowledge check and the parser produced no button. The
    // SRD-canonical Italian skill name is "Arcano" (masc) but the
    // English/feminine "Arcana" surfaces frequently in master prose;
    // both must produce a button, normalised to "Arcano" in the label.
    const reqs = parseRollRequests('Tira una prova di Arcana.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.label).toBe('Arcano');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('parses "tira una prova di Indagine" (Investigation alias)', () => {
    // User report: master narrated "Per cavarne dettagli utili, devi
    // passarla al setaccio. Tira una prova di Indagine." but no roll
    // button rendered because the parser only knew "Investigazione".
    // Both "Indagine" and "Indagare" are common Italian translations
    // of the Investigation skill — accept either, normalise to the
    // canonical "Investigazione".
    const reqs1 = parseRollRequests('Tira una prova di Indagine.');
    expect(reqs1.length).toBe(1);
    expect(reqs1[0]!.formula).toBe('1d20');
    expect(reqs1[0]!.label).toBe('Investigazione');
    expect(reqs1[0]!.kind).toBe('check');

    const reqs2 = parseRollRequests('Fai una prova di Indagare CD 12.');
    expect(reqs2[0]!.label).toBe('Investigazione (CD 12)');
  });
});

describe('parseRollRequests — Italian saving throws (no explicit formula)', () => {
  it('parses "tira un TS Destrezza CD 14"', () => {
    const reqs = parseRollRequests('Tira un TS Destrezza CD 14.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.formula).toBe('1d20');
    expect(reqs[0]!.label).toBe('TS DES (CD 14)');
    expect(reqs[0]!.kind).toBe('save');
  });

  it('parses "tira un tiro salvezza di Costituzione (CD 12)"', () => {
    const reqs = parseRollRequests('Tira un tiro salvezza di Costituzione (CD 12).');
    expect(reqs[0]!.label).toBe('TS COS (CD 12)');
  });

  it('parses "fai un TS Saggezza" without DC', () => {
    const reqs = parseRollRequests('Fai un TS Saggezza.');
    expect(reqs[0]!.label).toBe('TS SAG');
  });

  // The Master is instructed to use "TS <Ability>" or "tiro salvezza di
  // <Ability>", but the LLM frequently slips into natural-Italian
  // "su" + article phrasings ("sulla Saggezza", "sul Carisma",
  // "sull'Intelligenza"). The parser accepts these so the player still gets
  // a save button — see the spell-save bug where "Fai un tiro salvezza sulla
  // Saggezza" produced no roll prompt in multiplayer.
  it('parses "fai un tiro salvezza sulla Saggezza" (su + article)', () => {
    const reqs = parseRollRequests(`Fai un tiro salvezza sulla Saggezza per resistere.`);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('TS SAG');
    expect(reqs[0]!.kind).toBe('save');
  });

  it('parses "tira un TS sull\'Intelligenza CD 15" (elided form)', () => {
    const reqs = parseRollRequests(`Tira un TS sull'Intelligenza CD 15.`);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('TS INT (CD 15)');
  });

  it('parses "fai un tiro salvezza sul Carisma" (masculine article)', () => {
    const reqs = parseRollRequests('Fai un tiro salvezza sul Carisma.');
    expect(reqs[0]!.label).toBe('TS CAR');
  });

  it('parses "fai un tiro salvezza su Costituzione" (bare "su")', () => {
    const reqs = parseRollRequests('Fai un tiro salvezza su Costituzione.');
    expect(reqs[0]!.label).toBe('TS COS');
  });
});

describe('parseRollRequests — Italian skill checks with "su" prepositions', () => {
  it('parses "tira una prova sulla Forza" (su + article)', () => {
    const reqs = parseRollRequests('Tira una prova sulla Forza.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('Forza');
    expect(reqs[0]!.kind).toBe('check');
  });

  it(`parses "tira una prova sull'Atletica" (elided form)`, () => {
    const reqs = parseRollRequests(`Tira una prova sull'Atletica.`);
    expect(reqs[0]!.label).toBe('Atletica');
  });
});

// The master often restates the same check in two beats — once in narration
// ("Fai una prova di Intuizione per capire se...") and once in the closing
// prompt ("Tira una prova di Intuizione."). Without dedup the UI showed two
// indistinguishable buttons, asking the player to roll the same check twice.
// See the "I rolled 20 in naturale, why is it making me roll again?" report.
describe('parseRollRequests — duplicate-check dedup', () => {
  it('collapses two mentions of the same Italian check (no DC) to one button', () => {
    const text =
      'Fai una prova di Intuizione per capire se anche lui rispetterà il patto.\n\nTira una prova di Intuizione.';
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('Intuito');
    expect(reqs[0]!.kind).toBe('check');
  });

  it('keeps the DC-bearing variant when one mention has a DC and the other does not', () => {
    const text =
      'Fai una prova di Percezione per accorgerti della porta nascosta. Tira una prova di Percezione CD 14.';
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('Percezione (CD 14)');
  });

  it('keeps both when the same skill is asked with DIFFERENT DCs (distinct rolls)', () => {
    const text =
      'Fai una prova di Forza CD 14 per scalare il pendio. Poi, fai una prova di Forza CD 18 per scalare la pietra finale.';
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(2);
    expect(reqs.map((r) => r.label).sort()).toEqual(['Forza (CD 14)', 'Forza (CD 18)']);
  });

  it('keeps two DIFFERENT Italian saves as separate buttons', () => {
    // Separate sentences so each is preceded by its own verb — the regex
    // requires `tira/fai/...` at the start of every match.
    const text = `Tira un TS Destrezza CD 14. Poi tira un TS Costituzione CD 12.`;
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(2);
    expect(reqs.map((r) => r.label).sort()).toEqual(['TS COS (CD 12)', 'TS DES (CD 14)']);
  });

  it('collapses two mentions of the same Italian save (no DC) to one button', () => {
    const text =
      `L'aria si fa pesante. Fai un TS Saggezza per resistere. Tira un TS Saggezza.`;
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('TS SAG');
  });
});

describe('bulletIndexAt', () => {
  it('returns null for prose before any bullet', () => {
    const text = 'Vuoi:\n- Opzione A: tira 1d20.\n- Opzione B: tira 1d20.';
    // Position inside "Vuoi:" header.
    expect(bulletIndexAt(text, 2)).toBeNull();
  });

  it('returns 0 for content inside the first bullet', () => {
    const text = 'Vuoi:\n- Opzione A: tira 1d20.\n- Opzione B: tira 1d20.';
    const idx = text.indexOf('1d20'); // first formula
    expect(bulletIndexAt(text, idx)).toBe(0);
  });

  it('returns 1 for content inside the second bullet', () => {
    const text = 'Vuoi:\n- Opzione A: tira 1d20+1.\n- Opzione B: tira 1d20+2.';
    const idx = text.indexOf('1d20+2');
    expect(bulletIndexAt(text, idx)).toBe(1);
  });
});

describe('parseRollRequests — bullet-aware label numbering', () => {
  it('appends "(N)" suffixes when each roll lives in its own bullet', () => {
    // The screenshot scenario: 3 attack options, each in its own bullet.
    // After the attack/damage filter strips the conditional damage rolls,
    // the surviving 3 attack rolls each sit inside a distinct bullet, so
    // we suffix their labels with (1), (2), (3) for disambiguation.
    const text =
      'Vuoi:\n' +
      '- Caricare il fuggitivo: tira 1d20+4 per attaccare. Se colpisci, tira 1d8+2 danni taglienti.\n' +
      '- Scattare sulla sentinella: tira 1d20+4 per attaccare. Se colpisci, tira 1d8+2 danni taglienti.\n' +
      "- Imbracciare l'arco: tira 1d20+3 per l'attacco con l'arco corto. Se colpisci, tira 1d6+1 danni perforanti.";
    const reqs = parseRollRequests(text);
    expect(reqs.length).toBe(3);
    expect(reqs[0]!.label).toBe('1d20+4 (attaccare) (1)');
    expect(reqs[1]!.label).toBe('1d20+4 (attaccare) (2)');
    expect(reqs[2]!.label).toBe("1d20+3 (l'attacco con l'arco corto) (3)");
  });

  it('does NOT suffix when there is only one roll', () => {
    const reqs = parseRollRequests('Vuoi:\n- Solo una scelta: tira 1d20+5 per attaccare.');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.label).toBe('1d20+5 (attaccare)');
  });

  it('does NOT suffix when rolls are in flowing prose (no bullets)', () => {
    const reqs = parseRollRequests(
      'Roll 1d20+2 for a Perception check. Also, roll 1d20+3 for an Insight check.',
    );
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.label).toBe('1d20+2 (Perception)');
    expect(reqs[1]!.label).toBe('1d20+3 (Insight)');
  });

  it('does NOT suffix when two rolls share the same bullet', () => {
    // If the master puts two rolls in the same bullet, our heuristic skips
    // numbering — sharing a "(N)" would be ambiguous.
    const reqs = parseRollRequests(
      'Vuoi:\n- Doppia prova: tira 1d20+2 per Sopravvivenza poi tira 1d20+1 per Furtività.\n- Singola: tira 1d20 per Investigazione.',
    );
    // Three rolls total; first two share bullet 0, third is in bullet 1 → not all distinct → no suffix.
    expect(reqs.length).toBe(3);
    for (const r of reqs) expect(r.label).not.toMatch(/\(\d\)$/);
  });
});

describe('pickAutoRoll', () => {
  // The screenshot scenario: 3-bullet "Vuoi:" with attack on bullet 1,
  // dash (no roll) on bullet 2, intimidation on bullet 3. The player can
  // commit to any option in prose without clicking a button.
  const masterMessage =
    'Tocca a te. Vuoi:\n' +
    '- Scoccare una freccia al fuggitivo in fuga: tira 1d20+3 per attaccare il fuggitivo (CA 14 con mezza copertura).\n' +
    '- Inseguirlo a tutta velocità con una Corsa (Dash): nessun tiro.\n' +
    '- Fermarlo a voce con un urlo minaccioso: tira una prova di Intimidazione CD 12.';

  it('matches the intimidation bullet from "intimidisco urlando"', () => {
    const reqs = parseRollRequests(masterMessage);
    const matched = pickAutoRoll('intimidisco urlando', reqs, masterMessage);
    expect(matched).not.toBeNull();
    expect(matched!.kind).toBe('check');
    expect(matched!.label).toContain('Intimidazione');
  });

  it('matches the intimidation bullet via skill synonyms when the prose is creative', () => {
    // Reproduces the user's scenario: the player commits to intimidating in
    // their own words, mentioning the bow as a threat ("Punto l'arco verso
    // il fuggitivo, gridando ... gli ordino di fermarsi"). The previous
    // letter-overlap matcher tied 1-1 between the attack and intimidation
    // bullets and skipped the auto-roll. With skill synonyms, "gridando"
    // and "ordino" both expand into the Intimidazione bullet's keyword set
    // (gridare/ordinare are canonical Intimidation verbs), so bullet 3
    // wins clearly.
    const reqs = parseRollRequests(masterMessage);
    const matched = pickAutoRoll(
      "Punto l'arco verso il fuggitivo, gridando che ho la mira pronta sulla sua testa e gli ordino di fermarsi.",
      reqs,
      masterMessage,
    );
    expect(matched).not.toBeNull();
    expect(matched!.kind).toBe('check');
    expect(matched!.label).toContain('Intimidazione');
  });

  it('matches the intimidation bullet from "grido per intimidirlo"', () => {
    const reqs = parseRollRequests(masterMessage);
    const matched = pickAutoRoll('grido per intimidirlo', reqs, masterMessage);
    expect(matched).not.toBeNull();
    expect(matched!.label).toContain('Intimidazione');
  });

  it('matches the attack bullet from "scocco una freccia al fuggitivo"', () => {
    const reqs = parseRollRequests(masterMessage);
    const matched = pickAutoRoll('scocco una freccia al fuggitivo', reqs, masterMessage);
    expect(matched).not.toBeNull();
    expect(matched!.kind).toBe('attack');
    expect(matched!.formula).toBe('1d20+3');
  });

  it('returns null when the prose matches no bullet ("voglio guardarmi intorno")', () => {
    const reqs = parseRollRequests(masterMessage);
    const matched = pickAutoRoll('voglio guardarmi intorno', reqs, masterMessage);
    expect(matched).toBeNull();
  });

  it('returns null when the prose matches the no-roll bullet (Inseguirlo / Dash)', () => {
    // Bullet 2 has no roll, so "lo inseguo correndo" matches a bullet but
    // not one of the parsed requests. With no overlap to bullet 1 or 3, we
    // expect null.
    const reqs = parseRollRequests(masterMessage);
    const matched = pickAutoRoll('lo inseguo correndo', reqs, masterMessage);
    expect(matched).toBeNull();
  });

  it('returns null for AND-mode messages even with a clear keyword match', () => {
    // Two simultaneous saves — every roll required, can't pick just one.
    const text =
      "L'esplosione ti investe. Roll a DC 14 Dexterity save. Then roll a DC 12 Constitution save.";
    const reqs = parseRollRequests(text);
    expect(reqs.every((r) => r.groupMode === 'and')).toBe(true);
    const matched = pickAutoRoll('schivo l\'esplosione', reqs, text);
    expect(matched).toBeNull();
  });

  it('matches a single-roll message ("attacco con la spada")', () => {
    const text = 'Vedi un goblin. Roll 1d20+5 to attack the goblin (AC 13).';
    const reqs = parseRollRequests(text);
    const matched = pickAutoRoll('attacco col mio fendente', reqs, text);
    expect(matched).not.toBeNull();
    expect(matched!.formula).toBe('1d20+5');
  });

  it('returns null on empty player text', () => {
    const reqs = parseRollRequests(masterMessage);
    expect(pickAutoRoll('', reqs, masterMessage)).toBeNull();
  });

  it('returns null when the player text is a question (ends with "?")', () => {
    // Reproduces the screenshot bug: the master had offered a Longbow
    // damage option, the player asked "ho un longbow?" — that should NOT
    // trigger an auto-roll just because "longbow" matches the bullet.
    // Questions are inquiries, not commitments.
    const text =
      'La tua freccia sfreccia dal bordo della barca. Scegli:\n' +
      '- Longbow: tira 1d8+1 danni perforanti.\n' +
      '- Shortbow: tira 1d6+1 danni perforanti.';
    const reqs = parseRollRequests(text);
    const matched = pickAutoRoll('ho un longbow?', reqs, text);
    expect(matched).toBeNull();
  });

  it('returns null even with whitespace after the question mark', () => {
    const text = 'Roll 1d20+5 to attack the goblin (AC 13).';
    const reqs = parseRollRequests(text);
    expect(pickAutoRoll('attacco col fendente?   ', reqs, text)).toBeNull();
  });

  it('still auto-rolls when the prose is a statement, not a question', () => {
    // Sanity: removing the "?" must restore the previous behavior.
    const text =
      'La tua freccia sfreccia dal bordo della barca. Scegli:\n' +
      '- Longbow: tira 1d8+1 danni perforanti.\n' +
      '- Shortbow: tira 1d6+1 danni perforanti.';
    const reqs = parseRollRequests(text);
    const matched = pickAutoRoll('uso il longbow', reqs, text);
    expect(matched).not.toBeNull();
    expect(matched!.formula).toBe('1d8+1');
  });

  it('returns null when there are no pending requests', () => {
    expect(pickAutoRoll('intimidisco', [], 'no rolls here')).toBeNull();
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
