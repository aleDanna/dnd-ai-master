import { describe, it, expect } from 'vitest';
import { validateWizardState } from '@/characters/validate';
import { emptyWizardState } from '@/characters/types';

describe('validateWizardState', () => {
  const completeOptions = {
    raceSlugs: ['half-elf', 'human'],
    classSlugs: ['fighter', 'wizard'],
    backgroundSlugs: ['soldier', 'sage'],
  };

  it('rejects empty wizard state', () => {
    const r = validateWizardState(emptyWizardState(), completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('race-required');
  });

  it('rejects unknown raceSlug', () => {
    const w = emptyWizardState();
    w.raceSlug = 'unknown';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('race-unknown');
  });

  it('requires identity.name', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('name-required');
  });

  it('accepts a complete state', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects ability scores outside 8..15 for standard array (lvl 1 only)', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilities.STR = 19;
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-out-of-range');
  });

  it('rejects standard array with duplicates / wrong values', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'array';
    w.abilities = { STR: 15, DEX: 15, CON: 13, INT: 12, WIS: 10, CHA: 8 };
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-array-mismatch');
  });

  it('rejects pointbuy that has not spent all 27 points', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'pointbuy';
    w.abilities = { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 };
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-pointbuy-incomplete');
  });

  it('rejects pointbuy that overspends the budget', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'pointbuy';
    // 15+15+15+8+8+8 = 9+9+9 = 27 (exactly on budget — valid)
    // Force overspend by going beyond max:
    w.abilities = { STR: 15, DEX: 15, CON: 15, INT: 12, WIS: 8, CHA: 8 };
    // Spent: 9+9+9+4+0+0 = 31 → over.
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-pointbuy-overspent');
  });

  it('accepts a valid completed pointbuy', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'pointbuy';
    // 15+14+13+12+10+8 = 9+7+5+4+2+0 = 27, all in [8..15]
    w.abilities = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
