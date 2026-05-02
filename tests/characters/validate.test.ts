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
});
