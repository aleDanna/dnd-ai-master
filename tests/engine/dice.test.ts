import { describe, it, expect } from 'vitest';
import { rollDice, rollD20, rollDamage } from '@/engine/dice';
import { makeSeededRng } from '@/engine/rand';

describe('rollDice', () => {
  it('parses XdY+Z and rolls X dice of size Y, summing with modifier Z', () => {
    const rng = makeSeededRng(123);
    const r = rollDice('3d6+2', rng);
    expect(r.rolls.length).toBe(3);
    r.rolls.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    });
    expect(r.modifier).toBe(2);
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 2);
    expect(r.formula).toBe('3d6+2');
  });

  it('parses XdY without modifier', () => {
    const rng = makeSeededRng(7);
    const r = rollDice('1d8', rng);
    expect(r.rolls.length).toBe(1);
    expect(r.modifier).toBe(0);
    expect(r.total).toBe(r.rolls[0]);
  });

  it('parses negative modifier', () => {
    const rng = makeSeededRng(5);
    const r = rollDice('2d4-1', rng);
    expect(r.modifier).toBe(-1);
  });

  it('throws on bad formula', () => {
    const rng = makeSeededRng(1);
    expect(() => rollDice('abc', rng)).toThrow();
    expect(() => rollDice('0d6', rng)).toThrow();
    expect(() => rollDice('1d0', rng)).toThrow();
  });
});

describe('rollD20', () => {
  it('rolls a single d20 with modifier', () => {
    const rng = makeSeededRng(1);
    const r = rollD20({ modifier: 5 }, rng);
    expect(r.rolls.length).toBe(1);
    expect(r.modifier).toBe(5);
    expect(r.total).toBe(r.rolls[0]! + 5);
  });

  it('with advantage rolls 2d20 and takes higher', () => {
    const rng = makeSeededRng(42);
    const r = rollD20({ advantage: true, modifier: 3 }, rng);
    expect(r.rolls.length).toBe(2);
    expect(r.total).toBe(Math.max(...r.rolls) + 3);
    expect(r.meta?.advantage).toBe(true);
  });

  it('with disadvantage rolls 2d20 and takes lower', () => {
    const rng = makeSeededRng(42);
    const r = rollD20({ disadvantage: true, modifier: 0 }, rng);
    expect(r.rolls.length).toBe(2);
    expect(r.total).toBe(Math.min(...r.rolls));
    expect(r.meta?.disadvantage).toBe(true);
  });

  it('advantage AND disadvantage cancel — single d20', () => {
    const rng = makeSeededRng(99);
    const r = rollD20({ advantage: true, disadvantage: true }, rng);
    expect(r.rolls.length).toBe(1);
    expect(r.meta?.advantage).toBeUndefined();
    expect(r.meta?.disadvantage).toBeUndefined();
  });
});

describe('rollDamage', () => {
  it('rolls per the formula', () => {
    const rng = makeSeededRng(11);
    const r = rollDamage('2d6+3', { crit: false }, rng);
    expect(r.rolls.length).toBe(2);
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 3);
  });

  it('on crit doubles the dice but not the modifier', () => {
    const rng = makeSeededRng(11);
    const r = rollDamage('1d8+4', { crit: true }, rng);
    expect(r.rolls.length).toBe(2);                          // doubled
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 4);
  });
});
