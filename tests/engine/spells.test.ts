import { describe, it, expect } from 'vitest';
import { castSpell } from '@/engine/spells';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor, ActorRuntimeState } from '@/engine/types';

const wizard: Character = {
  id: 'pc1', name: 'Lyra', level: 5, xp: 0,
  classSlug: 'wizard', raceSlug: 'high-elf', backgroundSlug: 'sage',
  abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 28, ac: 12, speed: 30,
  proficiencies: { saves: ['INT', 'WIS'], skills: ['Arcana', 'History'], expertise: [], weapons: [], armor: [], tools: [], languages: ['Common', 'Elvish'] },
  spellcasting: { ability: 'INT', spellSaveDC: 15, spellAttackBonus: 7, slotsMax: { 1: 4, 2: 3, 3: 2 }, spellsKnown: ['magic-missile', 'fireball', 'healing-word'], spellsPrepared: [] },
  features: [], inventory: [], hitDiceMax: 5, hitDieSize: 6,
};

const wizardRuntime: ActorRuntimeState = {
  actorId: 'pc1', hpCurrent: 28, tempHp: 0, deathSaves: { successes: 0, failures: 0 },
  conditions: [], spellSlotsUsed: {}, resourcesUsed: {},
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};
void goblin;

describe('castSpell', () => {
  it('refuses if caster lacks the spell', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'wish', slotLevel: 9, targets: [] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_known');
  });

  it('refuses if no slot available at requested level', () => {
    const exhausted: ActorRuntimeState = { ...wizardRuntime, spellSlotsUsed: { 1: 4 } };
    const r = castSpell({ caster: wizard, runtime: exhausted, spellSlug: 'magic-missile', slotLevel: 1, targets: [{ id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_slot');
  });

  it('magic-missile: 3 darts of 1d4+1 force, never miss, slot consumed', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'magic-missile', slotLevel: 1, targets: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
    const damageMuts = r.mutations.filter((m) => m.op === 'apply_damage');
    expect(damageMuts.length).toBe(3);
    damageMuts.forEach((m) => expect((m as { amount: number }).amount).toBeGreaterThanOrEqual(2));
  });

  it('magic-missile cast at level 2: 4 darts', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'magic-missile', slotLevel: 2, targets: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }, { id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    const damageMuts = r.mutations.filter((m) => m.op === 'apply_damage');
    expect(damageMuts.length).toBe(4);
  });

  it('healing-word heals one ally and consumes a slot', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'healing-word', slotLevel: 1, targets: [{ id: 'pc1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'heal')).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
  });

  it('unknown spell-slug returns clean error', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'no-such-spell', slotLevel: 1, targets: [] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_known');
  });
});
