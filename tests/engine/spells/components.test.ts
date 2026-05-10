import { describe, expect, it } from 'vitest';
import {
  parseComponents,
  validateComponents,
  focusKindForClass,
} from '../../../src/engine/spells/components';
import type {
  ConditionInstance,
  EquippedFocus,
} from '../../../src/engine/types';

function cond(slug: ConditionInstance['slug']): ConditionInstance {
  return { slug, source: 'test', durationRounds: 'until_removed', appliedRound: 0 };
}

describe('parseComponents', () => {
  it('returns all-false flags for empty/null/undefined input', () => {
    expect(parseComponents(undefined)).toEqual({ verbal: false, somatic: false, material: false });
    expect(parseComponents(null)).toEqual({ verbal: false, somatic: false, material: false });
    expect(parseComponents('')).toEqual({ verbal: false, somatic: false, material: false });
    expect(parseComponents('   ')).toEqual({ verbal: false, somatic: false, material: false });
  });

  it('parses just "V"', () => {
    expect(parseComponents('V')).toEqual({ verbal: true, somatic: false, material: false });
  });

  it('parses "V S"', () => {
    expect(parseComponents('V S')).toEqual({ verbal: true, somatic: true, material: false });
  });

  it('parses "V S M" without description', () => {
    expect(parseComponents('V S M')).toEqual({ verbal: true, somatic: true, material: true });
  });

  it('parses "V S M (a sprig of mistletoe)" — non-costly material', () => {
    const result = parseComponents('V S M (a sprig of mistletoe)');
    expect(result).toEqual({
      verbal: true,
      somatic: true,
      material: true,
      materialDescription: 'a sprig of mistletoe',
    });
    expect(result.materialCostly).toBeUndefined();
  });

  it('flags materialCostly when description mentions a gp cost', () => {
    const result = parseComponents('V S M (silver dust worth 25 gp)');
    expect(result.material).toBe(true);
    expect(result.materialCostly).toBe(true);
    expect(result.materialDescription).toBe('silver dust worth 25 gp');
  });

  it('flags materialCostly when description says "consumed"', () => {
    const result = parseComponents('V S M (a tiny ball of bat guano, consumed)');
    expect(result.materialCostly).toBe(true);
  });

  it('parses "V M (sprig)" — verbal+material only', () => {
    const result = parseComponents('V M (sprig)');
    expect(result.verbal).toBe(true);
    expect(result.somatic).toBe(false);
    expect(result.material).toBe(true);
    expect(result.materialDescription).toBe('sprig');
  });

  it('parses "S" only — somatic only spell (e.g., shield)', () => {
    expect(parseComponents('S')).toEqual({ verbal: false, somatic: true, material: false });
  });
});

describe('validateComponents', () => {
  const okFlags = {
    components: { verbal: true, somatic: true, material: false },
    casterConditions: [],
    freeHand: true,
    hasMaterial: true,
    canUseFocus: false,
  };

  it('passes when all components are satisfied', () => {
    expect(validateComponents(okFlags)).toBe(null);
  });

  it('returns silenced when V required and caster has silenced condition', () => {
    expect(
      validateComponents({
        ...okFlags,
        casterConditions: [cond('silenced')],
      }),
    ).toBe('silenced');
  });

  it('does NOT return silenced when V is not required', () => {
    expect(
      validateComponents({
        ...okFlags,
        components: { verbal: false, somatic: true, material: false },
        casterConditions: [cond('silenced')],
      }),
    ).toBe(null);
  });

  it('returns no_free_hand when somatic required and no hand and no focus', () => {
    expect(
      validateComponents({
        ...okFlags,
        freeHand: false,
      }),
    ).toBe('no_free_hand');
  });

  it('passes somatic when no hand but caster has matching focus', () => {
    const focus: EquippedFocus = { kind: 'arcane', itemSlug: 'orb' };
    expect(
      validateComponents({
        ...okFlags,
        freeHand: false,
        equippedFocus: focus,
        canUseFocus: true,
      }),
    ).toBe(null);
  });

  it('fails somatic when focus kind does not match (canUseFocus=false)', () => {
    const focus: EquippedFocus = { kind: 'arcane', itemSlug: 'orb' };
    expect(
      validateComponents({
        ...okFlags,
        freeHand: false,
        equippedFocus: focus,
        canUseFocus: false,
      }),
    ).toBe('no_free_hand');
  });

  it('returns missing_material when costly material required and not in inventory', () => {
    expect(
      validateComponents({
        ...okFlags,
        components: {
          verbal: true,
          somatic: true,
          material: true,
          materialCostly: true,
          materialDescription: 'diamond dust 100 gp',
        },
        hasMaterial: false,
      }),
    ).toBe('missing_material');
  });

  it('costly material: focus does NOT replace it — must possess', () => {
    const focus: EquippedFocus = { kind: 'arcane', itemSlug: 'orb' };
    expect(
      validateComponents({
        ...okFlags,
        components: {
          verbal: true,
          somatic: true,
          material: true,
          materialCostly: true,
          materialDescription: 'diamond dust 100 gp',
        },
        hasMaterial: false,
        equippedFocus: focus,
        canUseFocus: true,
      }),
    ).toBe('missing_material');
  });

  it('non-costly material: focus replaces it (no possession required)', () => {
    const focus: EquippedFocus = { kind: 'druidic', itemSlug: 'sprig-of-mistletoe' };
    expect(
      validateComponents({
        ...okFlags,
        components: {
          verbal: true,
          somatic: true,
          material: true,
          materialCostly: false,
          materialDescription: 'a sprig of mistletoe',
        },
        hasMaterial: false,
        equippedFocus: focus,
        canUseFocus: true,
      }),
    ).toBe(null);
  });

  it('non-costly material: hasMaterial=true alone is enough (no focus needed)', () => {
    expect(
      validateComponents({
        ...okFlags,
        components: {
          verbal: true,
          somatic: true,
          material: true,
          materialDescription: 'sprig',
        },
        hasMaterial: true,
      }),
    ).toBe(null);
  });

  it('S-only spell does not check verbal or material', () => {
    expect(
      validateComponents({
        ...okFlags,
        components: { verbal: false, somatic: true, material: false },
        casterConditions: [cond('silenced')],
        freeHand: true,
        hasMaterial: false,
      }),
    ).toBe(null);
  });
});

describe('focusKindForClass', () => {
  it('maps sorcerer/warlock/wizard to arcane', () => {
    expect(focusKindForClass('sorcerer')).toBe('arcane');
    expect(focusKindForClass('warlock')).toBe('arcane');
    expect(focusKindForClass('wizard')).toBe('arcane');
  });

  it('maps druid/ranger to druidic', () => {
    expect(focusKindForClass('druid')).toBe('druidic');
    expect(focusKindForClass('ranger')).toBe('druidic');
  });

  it('maps cleric/paladin to holy', () => {
    expect(focusKindForClass('cleric')).toBe('holy');
    expect(focusKindForClass('paladin')).toBe('holy');
  });

  it('maps bard to instrument', () => {
    expect(focusKindForClass('bard')).toBe('instrument');
  });

  it('returns null for non-caster classes', () => {
    expect(focusKindForClass('barbarian')).toBe(null);
    expect(focusKindForClass('fighter')).toBe(null);
    expect(focusKindForClass('monk')).toBe(null);
    expect(focusKindForClass('rogue')).toBe(null);
    expect(focusKindForClass('artificer')).toBe(null);
    expect(focusKindForClass('')).toBe(null);
  });
});
