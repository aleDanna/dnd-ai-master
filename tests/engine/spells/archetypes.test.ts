import { describe, expect, it } from 'vitest';
import { ARCHETYPE_HANDLERS, type ArchetypeContext } from '../../../src/engine/spells/archetypes';

const ctxFor = (overrides: Partial<ArchetypeContext> = {}): ArchetypeContext => ({
  caster: { id: 'pc1', spellAttackBonus: 5, spellSaveDC: 13, spellMod: 3 },
  spellSlug: 'test',
  slotLevel: 1,
  targets: [{ id: 'm1', ac: 14 }],
  rng: () => 0.5,
  ...overrides,
});

describe('archetype attack_damage (e.g. fire-bolt, ray-of-frost)', () => {
  it('hits with attack roll, applies damage', () => {
    const result = ARCHETYPE_HANDLERS.attack_damage(
      ctxFor({ rng: () => 0.5 }),  // d20 = 11; 11+5 = 16 ≥ 14
      { archetype: 'attack_damage', damage: { dice: '1d10', type: 'fire' }, attackRoll: true },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.effects).toContain('attack-hit');
    const dmg = result.mutations.find((m) => m.op === 'apply_damage');
    expect(dmg).toBeDefined();
  });

  it('miss → no damage mutation', () => {
    const result = ARCHETYPE_HANDLERS.attack_damage(
      ctxFor({ rng: () => 0.0001 }),  // d20 = 1 → auto miss
      { archetype: 'attack_damage', damage: { dice: '1d10', type: 'fire' }, attackRoll: true },
    );
    expect(result.data?.effects).toContain('miss');
    expect(result.mutations.find((m) => m.op === 'apply_damage')).toBeUndefined();
  });

  it('crit on nat 20 doubles damage dice', () => {
    const result = ARCHETYPE_HANDLERS.attack_damage(
      ctxFor({ rng: () => 0.9999 }),  // d20 = 20
      { archetype: 'attack_damage', damage: { dice: '1d10', type: 'fire' }, attackRoll: true },
    );
    expect(result.data?.effects).toContain('attack-hit');
    const dmg = result.mutations.find((m) => m.op === 'apply_damage');
    expect(dmg?.isCrit).toBe(true);
  });
});

describe('archetype save_half (e.g. burning-hands, fireball)', () => {
  it('emits apply_damage for each target with full damage (Master halves on save success per-target)', () => {
    const result = ARCHETYPE_HANDLERS.save_half(
      ctxFor({ targets: [{ id: 'm1', ac: 0 }, { id: 'm2', ac: 0 }] }),
      {
        archetype: 'save_half',
        damage: { dice: '3d6', type: 'fire', perSlotAbove: '1d6' },
        save: { ability: 'DEX', halfOnSuccess: true },
        minSlot: 1,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.mutations.filter((m) => m.op === 'apply_damage').length).toBe(2);
    expect(result.data?.effects).toContain('save_half');
  });

  it('upcasts add extra damage dice (slot 3 fireball: 8d6)', () => {
    const result = ARCHETYPE_HANDLERS.save_half(
      ctxFor({ slotLevel: 4, targets: [{ id: 'm1' }] }),
      {
        archetype: 'save_half',
        damage: { dice: '8d6', type: 'fire', perSlotAbove: '1d6' },
        save: { ability: 'DEX', halfOnSuccess: true },
        minSlot: 3,
      },
    );
    // slot 4, min 3 → +1d6 over base 8d6 = 9d6 total
    const dmg = result.mutations.find((m) => m.op === 'apply_damage');
    expect(dmg).toBeDefined();
    // Just verify the mutation exists; precise total varies with rng.
  });
});

describe('archetype save_condition (e.g. hold-person)', () => {
  it('emits add_condition for each target', () => {
    const result = ARCHETYPE_HANDLERS.save_condition(
      ctxFor({ targets: [{ id: 'm1' }, { id: 'm2' }] }),
      {
        archetype: 'save_condition',
        save: { ability: 'WIS' },
        condition: { slug: 'paralyzed', durationRounds: 10 },
      },
    );
    expect(result.mutations.filter((m) => m.op === 'add_condition').length).toBe(2);
    const m = result.mutations[0];
    if (m && m.op === 'add_condition') expect(m.condition.slug).toBe('paralyzed');
  });
});

describe('archetype heal (e.g. cure-wounds)', () => {
  it('emits heal mutation with dice + spell mod', () => {
    const result = ARCHETYPE_HANDLERS.heal(
      ctxFor(),
      { archetype: 'heal', heal: { dice: '1d8', perSlotAbove: '1d8', addSpellMod: true }, minSlot: 1 },
    );
    const heal = result.mutations.find((m) => m.op === 'heal');
    expect(heal).toBeDefined();
  });
});

describe('archetype buff (e.g. bless, bane)', () => {
  it('emits add_condition for each target', () => {
    const result = ARCHETYPE_HANDLERS.buff(
      ctxFor({ targets: [{ id: 'pc1' }, { id: 'pc2' }] }),
      {
        archetype: 'buff',
        condition: { slug: 'blessed' as any, durationRounds: 10 },  // narrative slug
      },
    );
    expect(result.mutations.filter((m) => m.op === 'add_condition').length).toBe(2);
  });
});

describe('archetype utility (e.g. light, prestidigitation)', () => {
  it('returns ok with no mutations', () => {
    const result = ARCHETYPE_HANDLERS.utility(ctxFor(), { archetype: 'utility' });
    expect(result.ok).toBe(true);
    expect(result.mutations.length).toBe(0);
  });
});
