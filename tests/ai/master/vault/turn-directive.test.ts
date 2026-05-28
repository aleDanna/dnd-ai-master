import { describe, it, expect } from 'vitest';
import { buildTurnDirective, appendDirectiveToHistory } from '@/ai/master/vault/turn-directive';

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
