import { describe, it, expect } from 'vitest';
import {
  TOOL_HANDLERS,
  handleAttune,
  handleUnattune,
} from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  EngineState,
  InventoryItem,
} from '@/engine/types';

// Helper: a minimal PC with the supplied inventory and current attunedItems.
function pc(opts: {
  id?: string;
  inventory?: InventoryItem[];
  attunedItems?: string[];
} = {}): Character {
  return {
    id: opts.id ?? 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 44,
    ac: 18,
    speed: 30,
    proficiencies: {
      saves: ['STR', 'CON'],
      skills: [],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: ['Light', 'Medium', 'Heavy', 'Shield'],
      tools: [],
      languages: ['Common'],
    },
    spellcasting: null,
    features: [],
    inventory: opts.inventory ?? [],
    attunedItems: opts.attunedItems,
    hitDiceMax: 5,
    hitDieSize: 10,
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
    scene: 'a quiet camp',
  };
}

describe('attune handler — PHB §10.1', () => {
  it('attunes to an item in inventory and emits an attune mutation', () => {
    const char = pc({
      inventory: [{ slug: 'cloak-of-protection', qty: 1, equipped: false }],
    });
    const state = stateWithPC(char);

    const r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ attuned: true });
    expect(r.mutations).toEqual([
      { op: 'attune', characterId: 'pc1', itemSlug: 'cloak-of-protection' },
    ]);
  });

  it('returns attuned:false (already_attuned) when the slug is already in attunedItems', () => {
    const char = pc({
      inventory: [{ slug: 'cloak-of-protection', qty: 1, equipped: false }],
      attunedItems: ['cloak-of-protection'],
    });
    const state = stateWithPC(char);

    const r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ attuned: false, reason: 'already_attuned' });
    expect(r.mutations).toEqual([]);
  });

  it('errors with attunement_cap_reached when the PC already has 3 attuned items', () => {
    const char = pc({
      inventory: [
        { slug: 'cloak-of-protection', qty: 1, equipped: false },
        { slug: 'ring-of-protection', qty: 1, equipped: false },
        { slug: 'amulet-of-health', qty: 1, equipped: false },
        { slug: 'belt-of-giant-strength', qty: 1, equipped: false },
      ],
      attunedItems: [
        'cloak-of-protection',
        'ring-of-protection',
        'amulet-of-health',
      ],
    });
    const state = stateWithPC(char);

    const r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'belt-of-giant-strength',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('attunement_cap_reached');
    expect(r.mutations).toEqual([]);
  });

  it('errors with item_not_in_inventory when the PC does not possess the item', () => {
    const char = pc({ inventory: [], attunedItems: [] });
    const state = stateWithPC(char);

    const r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('item_not_in_inventory');
    expect(r.mutations).toEqual([]);
  });

  it('errors with unknown_character when the character does not exist', () => {
    const state = stateWithPC(pc());

    const r = handleAttune(state, {
      character: 'ghost',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
    expect(r.mutations).toEqual([]);
  });

  it('attunes when the PC has 2 items already (under the cap)', () => {
    const char = pc({
      inventory: [
        { slug: 'cloak-of-protection', qty: 1, equipped: false },
        { slug: 'ring-of-protection', qty: 1, equipped: false },
        { slug: 'amulet-of-health', qty: 1, equipped: false },
      ],
      attunedItems: ['cloak-of-protection', 'ring-of-protection'],
    });
    const state = stateWithPC(char);

    const r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'amulet-of-health',
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ attuned: true });
    expect(r.mutations).toEqual([
      { op: 'attune', characterId: 'pc1', itemSlug: 'amulet-of-health' },
    ]);
  });
});

describe('unattune handler — PHB §10.1', () => {
  it('unattunes an attuned item and emits an unattune mutation', () => {
    const char = pc({
      inventory: [{ slug: 'cloak-of-protection', qty: 1, equipped: false }],
      attunedItems: ['cloak-of-protection'],
    });
    const state = stateWithPC(char);

    const r = handleUnattune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ unattuned: true });
    expect(r.mutations).toEqual([
      { op: 'unattune', characterId: 'pc1', itemSlug: 'cloak-of-protection' },
    ]);
  });

  it('returns unattuned:false (no mutation) when the slug is not attuned', () => {
    const char = pc({ attunedItems: [] });
    const state = stateWithPC(char);

    const r = handleUnattune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ unattuned: false });
    expect(r.mutations).toEqual([]);
  });

  it('errors with unknown_character when the character does not exist', () => {
    const state = stateWithPC(pc());

    const r = handleUnattune(state, {
      character: 'ghost',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
    expect(r.mutations).toEqual([]);
  });
});

describe('TOOL_HANDLERS dispatch (attune / unattune)', () => {
  it('attune handler accepts character ref via input.character and lowercases the slug', () => {
    const char = pc({
      inventory: [{ slug: 'cloak-of-protection', qty: 1, equipped: false }],
      attunedItems: [],
    });
    const state = stateWithPC(char);

    // Master may send mixed-case slugs; the dispatcher normalizes to lower.
    const r = TOOL_HANDLERS.attune!(state, {
      character: 'pc1',
      itemSlug: 'Cloak-Of-Protection',
    });

    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'attune', characterId: 'pc1', itemSlug: 'cloak-of-protection' },
    ]);
  });

  it('attune handler errors with invalid_slug when itemSlug is empty', () => {
    const char = pc({ attunedItems: [] });
    const state = stateWithPC(char);

    const r = TOOL_HANDLERS.attune!(state, {
      character: 'pc1',
      itemSlug: '',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_slug');
  });

  it('attune handler errors with unknown_character when character ref is missing', () => {
    const char = pc({ attunedItems: [] });
    const state = stateWithPC(char);

    const r = TOOL_HANDLERS.attune!(state, { itemSlug: 'cloak-of-protection' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });

  it('unattune handler dispatches and lowercases the slug', () => {
    const char = pc({ attunedItems: ['cloak-of-protection'] });
    const state = stateWithPC(char);

    const r = TOOL_HANDLERS.unattune!(state, {
      character: 'pc1',
      itemSlug: 'CLOAK-OF-PROTECTION',
    });

    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'unattune', characterId: 'pc1', itemSlug: 'cloak-of-protection' },
    ]);
  });

  it('attune handler resolves "player_character" alias when single PC in state', () => {
    const char = pc({
      inventory: [{ slug: 'cloak-of-protection', qty: 1, equipped: false }],
    });
    const state = stateWithPC(char);

    const r = TOOL_HANDLERS.attune!(state, {
      character: 'player_character',
      itemSlug: 'cloak-of-protection',
    });

    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'attune',
      characterId: 'pc1',
    });
  });
});
