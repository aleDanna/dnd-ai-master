import { describe, expect, it } from 'vitest';
import { SPELL_BINDINGS, bindingFor } from '../../../src/engine/spells/spell-data';

describe('SPELL_BINDINGS', () => {
  it('covers at least 30 spells', () => {
    expect(Object.keys(SPELL_BINDINGS).length).toBeGreaterThanOrEqual(30);
  });

  it('every binding has a valid archetype', () => {
    const valid = ['attack_damage', 'save_half', 'save_negate', 'save_condition', 'heal', 'buff', 'aoe_save', 'utility'];
    for (const [, binding] of Object.entries(SPELL_BINDINGS)) {
      expect(valid).toContain(binding.archetype);
    }
  });

  it('attack_damage and save_* bindings have damage', () => {
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      if (binding.archetype === 'attack_damage' || binding.archetype === 'save_half' || binding.archetype === 'aoe_save' || binding.archetype === 'save_negate') {
        if (slug === 'magic-missile') continue;  // multi-dart special
        expect(binding.damage, `${slug} missing damage`).toBeDefined();
      }
    }
  });

  it('save_* bindings have save', () => {
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      if (binding.archetype === 'save_half' || binding.archetype === 'save_negate' || binding.archetype === 'save_condition' || binding.archetype === 'aoe_save') {
        expect(binding.save, `${slug} missing save`).toBeDefined();
      }
    }
  });

  it('heal bindings have heal config', () => {
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      if (binding.archetype === 'heal') {
        expect(binding.heal, `${slug} missing heal`).toBeDefined();
      }
    }
  });

  it('bindingFor resolves a known spell', () => {
    expect(bindingFor('fire-bolt')).toBeDefined();
    expect(bindingFor('fire-bolt')?.archetype).toBe('attack_damage');
  });

  it('bindingFor returns undefined for unknown spell', () => {
    expect(bindingFor('nonexistent-spell')).toBeUndefined();
  });

  it('concentration spells are flagged correctly', () => {
    const concSpells = ['bless', 'bane', 'shield-of-faith', 'hold-person', 'fly'];
    for (const slug of concSpells) {
      expect(SPELL_BINDINGS[slug]?.concentration).toBe(true);
    }
  });
});
