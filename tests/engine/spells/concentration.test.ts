import { describe, expect, it } from 'vitest';
import {
  concentrationCheckDC,
  startConcentrationMutations,
  breakConcentrationMutations,
} from '../../../src/engine/spells/concentration';

describe('concentrationCheckDC', () => {
  it('damage 0 → DC 10', () => {
    expect(concentrationCheckDC(0)).toBe(10);
  });
  it('damage 10 → DC 10 (max(10, 5))', () => {
    expect(concentrationCheckDC(10)).toBe(10);
  });
  it('damage 21 → DC 10 (max(10, 10))', () => {
    expect(concentrationCheckDC(21)).toBe(10);
  });
  it('damage 22 → DC 11 (max(10, 11))', () => {
    expect(concentrationCheckDC(22)).toBe(11);
  });
  it('damage 50 → DC 25', () => {
    expect(concentrationCheckDC(50)).toBe(25);
  });
});

describe('startConcentrationMutations', () => {
  it('returns set_concentration mutation', () => {
    const muts = startConcentrationMutations({
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
    });
    expect(muts).toEqual([
      { op: 'set_concentration', actorId: 'pc1', spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
    ]);
  });

  it('if actor already concentrating on a different spell, emits break first', () => {
    const muts = startConcentrationMutations({
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
      currentlyConcentratingOn: { spellSlug: 'bane', slotLevel: 1, startedRound: 1 },
    });
    expect(muts[0]).toMatchObject({ op: 'break_concentration', actorId: 'pc1', reason: 'new_concentration' });
    expect(muts[1]).toMatchObject({ op: 'set_concentration', spellSlug: 'bless' });
  });

  it('if actor already concentrating on the same spell, no break', () => {
    const muts = startConcentrationMutations({
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
      currentlyConcentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 1 },
    });
    // re-cast same spell — break old, start new (the two represent different cast events)
    expect(muts[0]).toMatchObject({ op: 'break_concentration', reason: 'new_concentration' });
    expect(muts[1]).toMatchObject({ op: 'set_concentration' });
  });
});

describe('breakConcentrationMutations', () => {
  it('returns break_concentration mutation with reason', () => {
    const muts = breakConcentrationMutations({ actorId: 'pc1', reason: 'damage' });
    expect(muts).toEqual([{ op: 'break_concentration', actorId: 'pc1', reason: 'damage' }]);
  });
});
