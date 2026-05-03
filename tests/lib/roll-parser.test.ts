import { describe, it, expect } from 'vitest';
import { parseRollRequests, rollFormula, normalizeFormula } from '@/lib/roll-parser';

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
