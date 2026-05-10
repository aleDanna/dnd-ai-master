import { describe, it, expect } from 'vitest';
import {
  TOOL_HANDLERS,
  handleEquipFocus,
  handleUnequipFocus,
} from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  EngineState,
  EquippedFocus,
  InventoryItem,
} from '@/engine/types';

function pc(opts: {
  id?: string;
  classSlug?: string;
  inventory?: InventoryItem[];
  equippedFocus?: EquippedFocus;
} = {}): Character {
  return {
    id: opts.id ?? 'pc1',
    name: 'Lyra',
    level: 5,
    xp: 0,
    classSlug: opts.classSlug ?? 'wizard',
    raceSlug: 'high-elf',
    backgroundSlug: 'sage',
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
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
    spellcasting: null,
    features: [],
    inventory: opts.inventory ?? [],
    equippedFocus: opts.equippedFocus,
    hitDiceMax: 5,
    hitDieSize: 6,
  };
}

function stateWithPC(char: Character): EngineState {
  const rt: ActorRuntimeState = {
    actorId: char.id,
    hpCurrent: char.hpMax,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    conditions: [],
  };
  return {
    characters: [char],
    combatActors: [],
    runtime: { [char.id]: rt },
    combat: null,
    scene: 'a study',
  };
}

describe('handleEquipFocus — PHB §8.4', () => {
  it('equips a focus already in inventory and emits set_focus mutation', () => {
    const char = pc({
      inventory: [{ slug: 'crystal-orb', qty: 1, equipped: false }],
    });
    const state = stateWithPC(char);

    const r = handleEquipFocus(state, {
      character: 'pc1',
      kind: 'arcane',
      itemSlug: 'crystal-orb',
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      equipped: true,
      focus: { kind: 'arcane', itemSlug: 'crystal-orb' },
    });
    expect(r.mutations).toEqual([
      {
        op: 'set_focus',
        characterId: 'pc1',
        focus: { kind: 'arcane', itemSlug: 'crystal-orb' },
      },
    ]);
  });

  it('errors with item_not_in_inventory when the slug is not owned', () => {
    const char = pc();
    const state = stateWithPC(char);

    const r = handleEquipFocus(state, {
      character: 'pc1',
      kind: 'arcane',
      itemSlug: 'crystal-orb',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('item_not_in_inventory');
    expect(r.mutations).toEqual([]);
  });

  it('errors with invalid_focus_kind when kind is not one of the 4 canonical kinds', () => {
    const char = pc({
      inventory: [{ slug: 'orb', qty: 1, equipped: false }],
    });
    const state = stateWithPC(char);

    const r = handleEquipFocus(state, {
      character: 'pc1',
      // @ts-expect-error testing runtime guard
      kind: 'evil',
      itemSlug: 'orb',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_focus_kind');
  });

  it('errors with unknown_character when the PC id does not match', () => {
    const char = pc();
    const state = stateWithPC(char);

    const r = handleEquipFocus(state, {
      character: 'ghost',
      kind: 'arcane',
      itemSlug: 'crystal-orb',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });

  it('overwrites the previously equipped focus (replace by set_focus)', () => {
    const char = pc({
      inventory: [
        { slug: 'crystal-orb', qty: 1, equipped: false },
        { slug: 'wand', qty: 1, equipped: false },
      ],
      equippedFocus: { kind: 'arcane', itemSlug: 'crystal-orb' },
    });
    const state = stateWithPC(char);

    const r = handleEquipFocus(state, {
      character: 'pc1',
      kind: 'arcane',
      itemSlug: 'wand',
    });

    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'set_focus',
        characterId: 'pc1',
        focus: { kind: 'arcane', itemSlug: 'wand' },
      },
    ]);
  });
});

describe('handleUnequipFocus — PHB §8.4', () => {
  it('emits unset_focus when a focus is currently held', () => {
    const char = pc({
      equippedFocus: { kind: 'arcane', itemSlug: 'crystal-orb' },
    });
    const state = stateWithPC(char);

    const r = handleUnequipFocus(state, { character: 'pc1' });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ unequipped: true });
    expect(r.mutations).toEqual([
      { op: 'unset_focus', characterId: 'pc1' },
    ]);
  });

  it('idempotent: returns unequipped:false (no mutation) when no focus held', () => {
    const char = pc();
    const state = stateWithPC(char);

    const r = handleUnequipFocus(state, { character: 'pc1' });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ unequipped: false });
    expect(r.mutations).toEqual([]);
  });

  it('errors with unknown_character on unknown id', () => {
    const char = pc();
    const state = stateWithPC(char);

    const r = handleUnequipFocus(state, { character: 'ghost' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

describe('TOOL_HANDLERS routing — equip_focus / unequip_focus', () => {
  it('equip_focus tool entry resolves player_character and dispatches', () => {
    const char = pc({
      inventory: [{ slug: 'staff-of-power', qty: 1, equipped: false }],
    });
    const state = stateWithPC(char);

    const r = TOOL_HANDLERS['equip_focus']!(state, {
      character: 'player_character',
      kind: 'arcane',
      itemSlug: 'staff-of-power',
    });

    expect(r.ok).toBe(true);
    const muts = r.mutations as { op: string; focus?: EquippedFocus }[];
    expect(muts[0]?.op).toBe('set_focus');
    expect(muts[0]?.focus).toEqual({ kind: 'arcane', itemSlug: 'staff-of-power' });
  });

  it('unequip_focus tool entry resolves player_character and dispatches', () => {
    const char = pc({
      equippedFocus: { kind: 'holy', itemSlug: 'amulet' },
    });
    const state = stateWithPC(char);

    const r = TOOL_HANDLERS['unequip_focus']!(state, {
      character: 'player_character',
    });

    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('unset_focus');
  });
});
