import { describe, expect, it } from 'vitest';
import { castSpell } from '@/engine/spells';
import { handleEquipFocus } from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  ConditionInstance,
  Mutation,
} from '@/engine/types';

/**
 * E2E loop tests for PHB §8.3 (V/S/M components) + §8.4 (focus). The tests
 * drive the engine through the full equip→cast cycle, asserting the
 * expected error / success outcomes from the 6 reference scenarios:
 *
 *   1. Wizard with arcane focus casts fire-bolt without a free hand → OK.
 *   2. Wizard without focus, both hands occupied → component_no_free_hand.
 *   3. Silenced wizard tries fire-bolt → component_silenced.
 *   4. Cleric without holy symbol, hands full → component_no_free_hand on cure-wounds.
 *   5. Wizard casts find-familiar without the consumed materials → component_missing_material.
 *   6. Wizard casts an unbound spell (e.g. wish) → narrative cast OK after components validated.
 */

function makeCharacter(overrides: Partial<Character> & { classSlug: string }): Character {
  return {
    id: 'pc1',
    name: 'Lyra',
    level: 5,
    xp: 0,
    raceSlug: 'high-elf',
    backgroundSlug: 'sage',
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 14, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 28,
    ac: 12,
    speed: 30,
    proficiencies: {
      saves: ['INT', 'WIS'],
      skills: ['Arcana'],
      expertise: [],
      weapons: [],
      armor: [],
      tools: [],
      languages: ['Common'],
    },
    spellcasting: {
      ability: overrides.classSlug === 'cleric' ? 'WIS' : 'INT',
      spellSaveDC: 15,
      spellAttackBonus: 7,
      slotsMax: { 1: 4, 2: 3, 3: 2 },
      spellsKnown: ['fire-bolt', 'cure-wounds', 'find-familiar', 'wish', 'shield'],
      spellsPrepared: [],
    },
    features: [],
    inventory: [],
    hitDiceMax: 5,
    hitDieSize: 6,
    ...overrides,
  };
}

function runtimeFor(
  c: Character,
  conditions: ConditionInstance[] = [],
): ActorRuntimeState {
  return {
    actorId: c.id,
    hpCurrent: c.hpMax,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    conditions,
    spellSlotsUsed: {},
    resourcesUsed: {},
  };
}

describe('Phase 9 — spell components E2E loop (PHB §8.3-8.4)', () => {
  it('1. Wizard with arcane focus casts fire-bolt without a free hand → OK', () => {
    let wizard = makeCharacter({
      classSlug: 'wizard',
      inventory: [{ slug: 'crystal-orb', qty: 1, equipped: false }],
    });
    const state = {
      characters: [wizard],
      combatActors: [],
      runtime: { [wizard.id]: runtimeFor(wizard) },
      combat: null,
      scene: 'a study',
    };
    // Equip the focus
    const eq = handleEquipFocus(state, {
      character: wizard.id,
      kind: 'arcane',
      itemSlug: 'crystal-orb',
    });
    expect(eq.ok).toBe(true);
    // Apply the mutation in-memory
    const mut = eq.mutations[0] as Extract<Mutation, { op: 'set_focus' }>;
    wizard = { ...wizard, equippedFocus: mut.focus };

    // Cast fire-bolt with no free hand (both occupied) — focus saves us
    const cast = castSpell({
      caster: wizard,
      runtime: runtimeFor(wizard),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 12 }],
      spellMeta: {
        ritual: false,
        concentration: false,
        castingTime: '1 action',
        components: 'V S',
      },
      freeHand: false,
    }, () => 0.5);
    expect(cast.ok).toBe(true);
  });

  it('2. Wizard without focus, both hands occupied → component_no_free_hand', () => {
    const wizard = makeCharacter({ classSlug: 'wizard' });
    const cast = castSpell({
      caster: wizard,
      runtime: runtimeFor(wizard),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 12 }],
      spellMeta: { components: 'V S M (a tiny torch)' },
      freeHand: false,
    }, () => 0.5);
    expect(cast.ok).toBe(false);
    expect(cast.error).toBe('component_no_free_hand');
    expect(cast.mutations).toEqual([]);
  });

  it('3. Silenced wizard tries fire-bolt → component_silenced (V required)', () => {
    const wizard = makeCharacter({ classSlug: 'wizard' });
    const runtime = runtimeFor(wizard, [
      { slug: 'silenced', source: 'gag', durationRounds: 'until_removed', appliedRound: 0 },
    ]);
    const cast = castSpell({
      caster: wizard,
      runtime,
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 12 }],
      spellMeta: { components: 'V S M (a tiny torch)' },
    }, () => 0.5);
    expect(cast.ok).toBe(false);
    expect(cast.error).toBe('component_silenced');
  });

  it('4. Cleric without holy symbol equipped + hands occupied → component_no_free_hand on cure-wounds', () => {
    const cleric = makeCharacter({
      classSlug: 'cleric',
      // no equippedFocus
    });
    const cast = castSpell({
      caster: cleric,
      runtime: runtimeFor(cleric),
      spellSlug: 'cure-wounds',
      slotLevel: 1,
      targets: [{ id: cleric.id }],
      spellMeta: { components: 'V S' },
      freeHand: false,
    }, () => 0.5);
    expect(cast.ok).toBe(false);
    expect(cast.error).toBe('component_no_free_hand');
    // Slot must NOT be consumed when components fail (validation runs BEFORE slot use).
    expect(cast.mutations.some((m) => m.op === 'use_spell_slot')).toBe(false);
  });

  it('5. Wizard casts find-familiar without the consumed materials → component_missing_material', () => {
    const wizard = makeCharacter({ classSlug: 'wizard' });
    const cast = castSpell({
      caster: wizard,
      runtime: runtimeFor(wizard),
      spellSlug: 'find-familiar',
      slotLevel: 1,
      targets: [{ id: wizard.id }],
      spellMeta: {
        components:
          'V S M (10 gp worth of charcoal, incense, and herbs that must be consumed by fire in a brass brazier)',
      },
      hasMaterial: false,
    }, () => 0.5);
    expect(cast.ok).toBe(false);
    expect(cast.error).toBe('component_missing_material');
    expect(cast.mutations).toEqual([]);
  });

  it('6. Wizard casts wish (no spell binding) → narrative cast OK with slot consume + components validated', () => {
    const wizard = makeCharacter({
      classSlug: 'wizard',
      spellcasting: {
        ability: 'INT',
        spellSaveDC: 15,
        spellAttackBonus: 7,
        slotsMax: { 1: 4, 2: 3, 3: 2, 4: 2, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
        spellsKnown: ['wish'],
        spellsPrepared: [],
      },
    });
    const cast = castSpell({
      caster: wizard,
      runtime: runtimeFor(wizard),
      spellSlug: 'wish',
      slotLevel: 9,
      targets: [{ id: wizard.id }],
      spellMeta: {
        ritual: false,
        concentration: false,
        castingTime: '1 action',
        // wish is V only per PHB §10.205.
        components: 'V',
      },
    }, () => 0.5);
    expect(cast.ok).toBe(true);
    // Narrative cast → slot IS consumed.
    expect(cast.mutations.some((m) => m.op === 'use_spell_slot' && m.level === 9)).toBe(true);
    expect((cast.data as { effects: string[] }).effects).toContain('narrative');
  });

  it('bonus: focus replaces non-costly materials (cleric with holy symbol, no inventory possession)', () => {
    let cleric = makeCharacter({
      classSlug: 'cleric',
      inventory: [{ slug: 'amulet-of-light', qty: 1, equipped: false }],
    });
    const state = {
      characters: [cleric],
      combatActors: [],
      runtime: { [cleric.id]: runtimeFor(cleric) },
      combat: null,
      scene: 'a chapel',
    };
    const eq = handleEquipFocus(state, {
      character: cleric.id,
      kind: 'holy',
      itemSlug: 'amulet-of-light',
    });
    expect(eq.ok).toBe(true);
    const mut = eq.mutations[0] as Extract<Mutation, { op: 'set_focus' }>;
    cleric = { ...cleric, equippedFocus: mut.focus };

    // Cast cure-wounds (V S) with no free hand — focus replaces the
    // somatic requirement.
    const cast = castSpell({
      caster: cleric,
      runtime: runtimeFor(cleric),
      spellSlug: 'cure-wounds',
      slotLevel: 1,
      targets: [{ id: cleric.id }],
      spellMeta: { components: 'V S' },
      freeHand: false,
    }, () => 0.5);
    expect(cast.ok).toBe(true);
  });
});
