import { describe, expect, it } from 'vitest';
import { SPELL_BINDINGS, bindingFor } from '../../../src/engine/spells/spell-data';

describe('SPELL_BINDINGS', () => {
  it('covers at least 30 spells', () => {
    expect(Object.keys(SPELL_BINDINGS).length).toBeGreaterThanOrEqual(30);
  });

  it('Phase 9: covers at least 150 spells (expanded SRD coverage)', () => {
    expect(Object.keys(SPELL_BINDINGS).length).toBeGreaterThanOrEqual(150);
  });

  it('Phase 9: includes the most common spells the master will reach for', () => {
    const mustHave = [
      // Cantrips
      'fire-bolt', 'eldritch-blast', 'sacred-flame', 'mage-hand',
      // 1st
      'magic-missile', 'cure-wounds', 'healing-word', 'shield', 'mage-armor',
      'bless', 'bane', 'sleep', 'burning-hands', 'thunderwave',
      // 2nd
      'hold-person', 'invisibility', 'misty-step', 'scorching-ray', 'web',
      // 3rd
      'fireball', 'lightning-bolt', 'counterspell', 'fly', 'dispel-magic',
      'haste', 'fear', 'hypnotic-pattern', 'spirit-guardians',
      // 4th
      'banishment', 'greater-invisibility', 'wall-of-fire', 'stoneskin',
      // 5th
      'cone-of-cold', 'mass-cure-wounds', 'hold-monster', 'wall-of-force',
      // 6th-9th
      'disintegrate', 'chain-lightning', 'finger-of-death', 'meteor-swarm',
    ];
    for (const slug of mustHave) {
      expect(SPELL_BINDINGS[slug], `expected '${slug}' to have a binding`).toBeDefined();
    }
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
