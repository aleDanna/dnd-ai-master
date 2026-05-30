import { describe, it, expect } from 'vitest';
import { buildTurnDirective, appendDirectiveToHistory, detectCombatIntent, isRollResult } from '@/ai/master/vault/turn-directive';

describe('buildTurnDirective', () => {
  describe('null gate — returns null when no mechanics requested', () => {
    it('returns null when called with no options', () => {
      expect(buildTurnDirective({})).toBeNull();
    });

    it('returns null when vaultMutations is false and manualRolls is false', () => {
      expect(buildTurnDirective({ vaultMutations: false, manualRolls: false })).toBeNull();
    });

    it('returns null when vaultMutations is undefined and manualRolls is undefined', () => {
      expect(buildTurnDirective({ vaultMutations: undefined, manualRolls: undefined })).toBeNull();
    });
  });

  describe('POV line — always present when directive is non-null', () => {
    it('contains a 2nd-person POV line when vaultMutations is true', () => {
      const result = buildTurnDirective({ vaultMutations: true });
      expect(result).not.toBeNull();
      // Must mention "tu" or second-person narration in Italian
      expect(result!.toLowerCase()).toMatch(/\btu\b|seconda persona|second.person/);
    });

    it('contains a 2nd-person POV line when manualRolls is true', () => {
      const result = buildTurnDirective({ manualRolls: true });
      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).toMatch(/\btu\b|seconda persona|second.person/);
    });

    it('contains a 2nd-person POV line when both are true', () => {
      const result = buildTurnDirective({ vaultMutations: true, manualRolls: true });
      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).toMatch(/\btu\b|seconda persona|second.person/);
    });
  });

  describe('apply_event / combat line — only when vaultMutations is true', () => {
    it('contains apply_event and combat event names when vaultMutations is true', () => {
      const result = buildTurnDirective({ vaultMutations: true });
      expect(result).not.toBeNull();
      expect(result!).toContain('apply_event');
      expect(result!).toContain('combat_start');
      expect(result!).toContain('combat_end');
    });

    it('includes all key combat event type names', () => {
      const result = buildTurnDirective({ vaultMutations: true });
      expect(result!).toContain('monster_spawn');
      expect(result!).toContain('initiative_set');
      expect(result!).toContain('monster_hp_change');
      expect(result!).toContain('turn_advance');
    });

    it('does NOT contain apply_event when vaultMutations is false/absent', () => {
      const result = buildTurnDirective({ manualRolls: true });
      expect(result).not.toBeNull();
      expect(result!).not.toContain('apply_event');
    });

    it('does NOT contain combat event names when vaultMutations is false', () => {
      const result = buildTurnDirective({ manualRolls: true });
      expect(result!).not.toContain('combat_start');
    });
  });

  describe('roll line — only when manualRolls is true', () => {
    it('contains a roll request directive when manualRolls is true', () => {
      const result = buildTurnDirective({ manualRolls: true });
      expect(result).not.toBeNull();
      // Must mention asking for a roll — "Tira" is the Italian imperative
      expect(result!).toMatch(/[Tt]ira|chiedi.*tiro|tiro/i);
    });

    it('does NOT contain roll line when manualRolls is false/absent', () => {
      const result = buildTurnDirective({ vaultMutations: true });
      expect(result).not.toBeNull();
      // Should not have a Tira/chiedi un tiro directive
      expect(result!).not.toMatch(/[Tt]ira 1d20|chiedi un tiro/i);
    });
  });

  describe('combined — both vaultMutations and manualRolls', () => {
    it('contains POV + apply_event/combat + roll lines when both true', () => {
      const result = buildTurnDirective({ vaultMutations: true, manualRolls: true });
      expect(result).not.toBeNull();
      // POV
      expect(result!.toLowerCase()).toMatch(/\btu\b|seconda persona|second.person/);
      // combat
      expect(result!).toContain('apply_event');
      expect(result!).toContain('combat_start');
      // roll
      expect(result!).toMatch(/[Tt]ira|chiedi.*tiro/i);
    });
  });

  describe('determinism', () => {
    it('produces identical output across 100 calls with same opts', () => {
      const opts = { vaultMutations: true, manualRolls: true };
      const first = buildTurnDirective(opts);
      for (let i = 0; i < 99; i++) {
        expect(buildTurnDirective(opts)).toBe(first);
      }
    });

    it('produces identical output for null case across 100 calls', () => {
      const first = buildTurnDirective({});
      for (let i = 0; i < 99; i++) {
        expect(buildTurnDirective({})).toBe(first);
      }
    });
  });

  describe('header marker', () => {
    it('starts with a recognizable header marker', () => {
      const result = buildTurnDirective({ vaultMutations: true });
      // Must start with some kind of header/reminder marker
      expect(result!).toMatch(/^\[/);
    });
  });

  // REQ-038 — combat-intent-aware situational directive. Validated 2026-05-29
  // (_probe-combat.ts): the general directive was too soft to break narration
  // anchoring; the situational combat-first directive bootstraps combat 3/3.
  describe('combat-intent situational directive', () => {
    it('switches to the STRONG combat-first directive when player message is an attack + vaultMutations', () => {
      const result = buildTurnDirective({ vaultMutations: true, manualRolls: true, playerMessage: 'attacco Veyra con un pugno' });
      expect(result).not.toBeNull();
      expect(result!).toContain('PRIORITARIA');
      expect(result!).toContain('combat_start');
      expect(result!).toContain('monster_spawn');
      expect(result!).toContain('initiative_set');
      expect(result!).toMatch(/[Tt]ira 1d20/);
      expect(result!.toLowerCase()).toMatch(/seconda persona/);
      // The strong directive leads with the priority marker, NOT the general header.
      expect(result!).not.toContain('[Promemoria di sistema');
    });

    it('uses the GENERAL directive (not the strong one) when player message has NO combat intent', () => {
      const result = buildTurnDirective({ vaultMutations: true, manualRolls: true, playerMessage: 'esamino la stanza con calma' });
      expect(result).not.toBeNull();
      expect(result!).toContain('[Promemoria di sistema');
      expect(result!).not.toContain('PRIORITARIA');
    });

    it('does NOT use the strong directive when combat intent present but vaultMutations is off', () => {
      const result = buildTurnDirective({ manualRolls: true, playerMessage: 'attacco il nemico' });
      expect(result).not.toBeNull();
      expect(result!).not.toContain('PRIORITARIA');
      expect(result!).not.toContain('combat_start');
    });

    it('strong directive is deterministic across 100 calls', () => {
      const opts = { vaultMutations: true, manualRolls: true, playerMessage: 'colpisco con la spada' };
      const first = buildTurnDirective(opts);
      for (let i = 0; i < 99; i++) expect(buildTurnDirective(opts)).toBe(first);
    });
  });
});

// REQ-038 — roll-result resolve directive (fixes the 2026-05-29 stall loop:
// a roll-result message echoes the attack label "...per attaccare Veyra",
// tripping combat-intent and re-asking the same roll forever).
describe('roll-result resolve directive', () => {
  const ROLL = '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).';

  it('isRollResult detects the in-app roll-result format', () => {
    expect(isRollResult(ROLL)).toBe(true);
    expect(isRollResult('🎲 I rolled **7** for damage')).toBe(true);
    expect(isRollResult('attacco Veyra')).toBe(false);
    expect(isRollResult(undefined)).toBe(false);
  });

  it('returns the RESOLVE directive (not combat-start) when the message is a roll result — even though it contains "attaccare"', () => {
    // This is the exact loop bug: ROLL contains "attaccare" so detectCombatIntent is true,
    // but isRollResult must win → resolve, not re-ask.
    expect(detectCombatIntent(ROLL)).toBe(true); // it DOES look like combat intent
    const result = buildTurnDirective({ vaultMutations: true, manualRolls: true, playerMessage: ROLL });
    expect(result).not.toBeNull();
    expect(result!).toContain('ha appena tirato');
    expect(result!).toContain('NON chiederlo di nuovo');
    expect(result!).toContain('monster_hp_change');
    expect(result!).toContain('turn_advance');
    // Must NOT be the combat-START directive (which would re-ask the roll).
    expect(result!).not.toContain('il giocatore sta attaccando');
  });

  it('resolve directive is deterministic', () => {
    const opts = { vaultMutations: true, manualRolls: true, playerMessage: ROLL };
    const first = buildTurnDirective(opts);
    for (let i = 0; i < 99; i++) expect(buildTurnDirective(opts)).toBe(first);
  });
});

// REQ-039 / D-07 — server-resolved suppression. On a turn the server already
// resolved (resolveCombat returned non-null), the player-side resolve directive
// (the 07-05 re-ask-breaker that instructs the model to call apply_event
// monster_hp_change / turn_advance) MUST be suppressed: the server's own
// narration directive takes over that turn. Belt-and-suspenders with the loop's
// suppressCombatMutations drop (RESEARCH Pitfall 3) — don't ASK for the events
// we're going to drop. Gated, not a deletion: when the flag is absent the
// Phase 07 resolve directive is byte-identical.
describe('D-07 — server-resolved suppression', () => {
  const ROLL = '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).';

  it('suppresses the resolve directive when serverResolved is true (+vaultMutations)', () => {
    const result = buildTurnDirective({ vaultMutations: true, serverResolved: true, playerMessage: ROLL });
    // The resolve branch (which would re-instruct the model) is gone.
    expect(result).not.toBeNull();
    expect(result!).not.toContain('monster_hp_change');
    expect(result!).not.toContain('ISTRUZIONE PRIORITARIA — il giocatore ha appena tirato');
  });

  it('regression: WITHOUT serverResolved the resolve directive is still emitted (+vaultMutations)', () => {
    const result = buildTurnDirective({ vaultMutations: true, playerMessage: ROLL });
    expect(result).not.toBeNull();
    expect(result!).toContain('monster_hp_change');
    expect(result!).toContain('ISTRUZIONE PRIORITARIA — il giocatore ha appena tirato');
  });

  it('serverResolved suppression is deterministic across 100 calls', () => {
    const opts = { vaultMutations: true, serverResolved: true, playerMessage: ROLL };
    const first = buildTurnDirective(opts);
    for (let i = 0; i < 99; i++) expect(buildTurnDirective(opts)).toBe(first);
  });
});

// D-16 / Phase 09 — server-resolved MONSTER-turn suppression. Mirrors D-07's
// serverResolved (the v1 player-side analog). On a turn the server already
// resolved the monster actions (the monster-turn loop emitted the authoritative
// monster_hp_change / hp_change / turn_advance events), the combat re-ask
// directives (the combat-intent strong directive + the vaultMutations combat
// catalog) MUST be suppressed: the server injects its own narration directive
// and re-asking would tell the model to emit the very events the loop already
// emitted (double-apply re-ask, RESEARCH Pitfall 3 / T-09-15). Belt-and-
// suspenders with the loop's suppressCombatMutations drop. Gated, not a
// deletion: when the flag is absent the Phase-08 output is byte-identical.
describe('D-16 — server-resolved monster-turn suppression (monsterResolved)', () => {
  it('suppresses the combat-intent strong directive when monsterResolved is true (+vaultMutations)', () => {
    // 'attacco il goblin' trips detectCombatIntent → without the gate this would
    // return the STRONG combat-first directive (combat_start / monster_spawn …).
    const result = buildTurnDirective({ vaultMutations: true, monsterResolved: true, playerMessage: 'attacco il goblin' });
    expect(result).not.toBeNull();
    // The combat-intent strong directive (which re-asks combat events) is gone.
    expect(result!).not.toContain('il giocatore sta attaccando');
    expect(result!).not.toContain('combat_start');
    expect(result!).not.toContain('monster_spawn');
    // The POV / 2nd-person line is still present (only the re-asks are suppressed).
    expect(result!.toLowerCase()).toMatch(/seconda persona/);
  });

  it('suppresses the vaultMutations combat-event catalog block when monsterResolved is true', () => {
    // No combat intent in the message → the general directive path. Without the
    // gate this emits the combat catalog (combat_start … monster_hp_change …
    // turn_advance re-ask). With monsterResolved it must be suppressed.
    const result = buildTurnDirective({ vaultMutations: true, monsterResolved: true });
    expect(result).not.toBeNull();
    expect(result!).not.toContain('combat_start');
    expect(result!).not.toContain('monster_hp_change');
    expect(result!).not.toContain('turn_advance');
    // POV line preserved.
    expect(result!.toLowerCase()).toMatch(/seconda persona/);
  });

  it('regression: monsterResolved ABSENT → byte-identical to current Phase-08 output (combat-intent path)', () => {
    const opts = { vaultMutations: true, manualRolls: true, playerMessage: 'attacco Veyra con un pugno' };
    const withFlagAbsent = buildTurnDirective(opts);
    const withFlagFalse = buildTurnDirective({ ...opts, monsterResolved: false });
    const withFlagUndefined = buildTurnDirective({ ...opts, monsterResolved: undefined });
    // The pre-change Phase-08 combat-intent directive (locked byte-for-byte).
    const PHASE_08_COMBAT_INTENT = [
      '[ISTRUZIONE PRIORITARIA — il giocatore sta attaccando]',
      '',
      'PRIMA di narrare l\'esito DEVI usare gli strumenti (apply_event):',
      '- Se il combattimento NON è ancora iniziato: chiama combat_start, poi monster_spawn per ogni nemico presente, poi initiative_set.',
      '- Se è già in corso: usa monster_hp_change e turn_advance secondo il turno.',
      'Poi chiedi il tiro al giocatore: "Tira 1d20+<bonus> per attaccare <nemico>."',
      'Narra l\'esito SOLO dopo che il giocatore ha tirato. Scrivi sempre in seconda persona ("tu").',
    ].join('\n');
    expect(withFlagAbsent).toBe(PHASE_08_COMBAT_INTENT);
    expect(withFlagFalse).toBe(PHASE_08_COMBAT_INTENT);
    expect(withFlagUndefined).toBe(PHASE_08_COMBAT_INTENT);
  });

  it('regression: monsterResolved ABSENT → byte-identical to current Phase-08 output (general/catalog path)', () => {
    const opts = { vaultMutations: true, manualRolls: true };
    const withFlagAbsent = buildTurnDirective(opts);
    const withFlagFalse = buildTurnDirective({ ...opts, monsterResolved: false });
    // The pre-change Phase-08 general directive (header + POV + combat catalog + roll).
    const PHASE_08_GENERAL = [
      '[Promemoria di sistema — IMPORTANTE]',
      '',
      'Narra sempre in seconda persona ("tu"): il soggetto delle azioni',
      'è sempre il personaggio giocante, non il suo nome proprio come soggetto.',
      '',
      'Quando lo stato di gioco cambia (danni, condizioni, inizio/fine scontro,',
      'turni in combattimento), USA apply_event — non limitarti alla narrazione.',
      'Tipi di evento per il combattimento:',
      '  combat_start, monster_spawn, initiative_set,',
      '  monster_hp_change, turn_advance, combat_end.',
      'Ogni cambiamento di stato DEVE passare per apply_event, poi narra il risultato.',
      '',
      'Quando l\'esito di un\'azione è incerto, chiedi un tiro al giocatore.',
      'Formula per attacchi: "Tira 1d20+<bonus> per attaccare <BERSAGLIO>."',
      'Formula per prove: "Tira una prova di <Abilità> (CD <n>)."',
      'Non inventare risultati: aspetta il messaggio del giocatore col numero in grassetto.',
      '',
    ].join('\n');
    expect(withFlagAbsent).toBe(PHASE_08_GENERAL);
    expect(withFlagFalse).toBe(PHASE_08_GENERAL);
  });

  it('monsterResolved still emits the manualRolls roll line (only combat re-asks are suppressed)', () => {
    // A monster-resolved turn with manualRolls on must still carry the roll
    // surface (the next PC turn may need it) and the POV line.
    const result = buildTurnDirective({ vaultMutations: true, manualRolls: true, monsterResolved: true });
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toMatch(/seconda persona/);
    expect(result!).toMatch(/[Tt]ira 1d20/);
    // But NOT the combat catalog re-ask.
    expect(result!).not.toContain('combat_start');
  });

  it('monsterResolved suppression is deterministic across 100 calls', () => {
    const opts = { vaultMutations: true, monsterResolved: true, playerMessage: 'attacco il goblin' };
    const first = buildTurnDirective(opts);
    for (let i = 0; i < 99; i++) expect(buildTurnDirective(opts)).toBe(first);
  });
});

describe('detectCombatIntent', () => {
  it('returns false for undefined / empty', () => {
    expect(detectCombatIntent(undefined)).toBe(false);
    expect(detectCombatIntent('')).toBe(false);
  });

  it('detects Italian attack verbs', () => {
    for (const m of ['attacco Veyra', 'lo attacco', 'provo a colpirlo', 'colpisco con la spada', 'mi scaglio verso di lui', 'sferro un pugno', 'ingaggio il combattimento', 'lo affronto', 'combatto contro di lui']) {
      expect(detectCombatIntent(m)).toBe(true);
    }
  });

  it('detects English attack verbs', () => {
    for (const m of ['I attack the goblin', 'strike the orc', 'I punch him']) {
      expect(detectCombatIntent(m)).toBe(true);
    }
  });

  it('returns false for non-combat messages', () => {
    for (const m of ['esamino la stanza', 'parlo con il barista', 'mi guardo intorno', 'apro la porta', 'voglio riposare']) {
      expect(detectCombatIntent(m)).toBe(false);
    }
  });
});

describe('appendDirectiveToHistory', () => {
  type Msg = { role: string; content: string };

  it('appends directive to the last user turn when last turn is user', () => {
    const history: Msg[] = [
      { role: 'user', content: 'Attacco Veyra.' },
    ];
    const result = appendDirectiveToHistory(history, 'DIRECTIVE');
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('Attacco Veyra.\n\nDIRECTIVE');
  });

  it('pushes a new user turn when last turn is assistant', () => {
    const history: Msg[] = [
      { role: 'user', content: 'Attacco Veyra.' },
      { role: 'assistant', content: 'Veyra schiva agilmente.' },
    ];
    const result = appendDirectiveToHistory(history, 'DIRECTIVE');
    expect(result).toHaveLength(3);
    expect(result[2]!.role).toBe('user');
    expect(result[2]!.content).toBe('DIRECTIVE');
  });

  it('pushes a new user turn when history is empty', () => {
    const result = appendDirectiveToHistory<Msg>([], 'DIRECTIVE');
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toBe('DIRECTIVE');
  });

  it('does NOT mutate the input array', () => {
    const history: Msg[] = [
      { role: 'user', content: 'Attacco.' },
    ];
    const original = history[0]!.content;
    appendDirectiveToHistory(history, 'DIRECTIVE');
    expect(history[0]!.content).toBe(original);
    expect(history).toHaveLength(1);
  });

  it('does NOT mutate the last element when appending', () => {
    const lastMsg: Msg = { role: 'user', content: 'Attacco.' };
    const history: Msg[] = [lastMsg];
    const result = appendDirectiveToHistory(history, 'DIRECTIVE');
    // Original object should be untouched
    expect(lastMsg.content).toBe('Attacco.');
    // Result should have new content
    expect(result[0]!.content).toBe('Attacco.\n\nDIRECTIVE');
    // They should not be the same object reference
    expect(result[0]).not.toBe(lastMsg);
  });

  it('returns a new array (does not mutate input array reference)', () => {
    const history: Msg[] = [{ role: 'user', content: 'Attacco.' }];
    const result = appendDirectiveToHistory(history, 'DIRECTIVE');
    expect(result).not.toBe(history);
  });

  it('preserves all preceding turns unchanged when appending to last user turn', () => {
    const history: Msg[] = [
      { role: 'user', content: 'Prima mossa.' },
      { role: 'assistant', content: 'Il nemico risponde.' },
      { role: 'user', content: 'Seconda mossa.' },
    ];
    const result = appendDirectiveToHistory(history, 'DIRECTIVE');
    expect(result).toHaveLength(3);
    expect(result[0]!.content).toBe('Prima mossa.');
    expect(result[1]!.content).toBe('Il nemico risponde.');
    expect(result[2]!.content).toBe('Seconda mossa.\n\nDIRECTIVE');
  });

  it('handles multi-turn history where last is assistant — inserts new user turn', () => {
    const history: Msg[] = [
      { role: 'user', content: 'Prima mossa.' },
      { role: 'assistant', content: 'Risposta master.' },
    ];
    const result = appendDirectiveToHistory(history, 'DIRECTIVE');
    expect(result).toHaveLength(3);
    expect(result[0]!.content).toBe('Prima mossa.');
    expect(result[1]!.content).toBe('Risposta master.');
    expect(result[2]!).toEqual({ role: 'user', content: 'DIRECTIVE' });
  });
});
