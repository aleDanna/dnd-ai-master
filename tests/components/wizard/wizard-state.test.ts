import { describe, it, expect } from 'vitest';
import { wizardReducer } from '@/components/wizard/wizard-state';
import { emptyWizardState } from '@/characters/types';

describe('wizardReducer', () => {
  it('set-race updates raceSlug', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'set-race', slug: 'half-elf' });
    expect(next.raceSlug).toBe('half-elf');
  });

  it('set-class updates classSlug', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'set-class', slug: 'wizard' });
    expect(next.classSlug).toBe('wizard');
  });

  it('set-background updates backgroundSlug', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'set-background', slug: 'sage' });
    expect(next.backgroundSlug).toBe('sage');
  });

  it('set-ability-method updates abilityMethod', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'set-ability-method', method: 'pointbuy' });
    expect(next.abilityMethod).toBe('pointbuy');
  });

  it('set-abilities replaces abilities object', () => {
    const next = wizardReducer(emptyWizardState(), {
      type: 'set-abilities',
      abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    });
    expect(next.abilities.STR).toBe(16);
    expect(next.abilities.CHA).toBe(10);
  });

  it('toggle-skill adds when absent', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'toggle-skill', skill: 'Athletics' });
    expect(next.skills).toContain('Athletics');
  });

  it('toggle-skill removes when present', () => {
    const initial = wizardReducer(emptyWizardState(), { type: 'toggle-skill', skill: 'Athletics' });
    const next = wizardReducer(initial, { type: 'toggle-skill', skill: 'Athletics' });
    expect(next.skills).not.toContain('Athletics');
  });

  it('set-equipment-choice updates choice', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'set-equipment-choice', choice: 'gold' });
    expect(next.equipmentChoice).toBe('gold');
  });

  it('set-identity-field updates a single field', () => {
    const next = wizardReducer(emptyWizardState(), { type: 'set-identity-field', field: 'name', value: 'Tharion' });
    expect(next.identity.name).toBe('Tharion');
    // Other fields unchanged
    expect(next.identity.alignment).toBe('True Neutral');
  });

  it('replace swaps the entire state', () => {
    const swap = { ...emptyWizardState(), raceSlug: 'gnome' };
    const next = wizardReducer(emptyWizardState(), { type: 'replace', state: swap });
    expect(next).toEqual(swap);
  });
});
