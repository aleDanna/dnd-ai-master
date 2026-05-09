import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleAttune,
  handleUnattune,
} from '@/engine/tools/handlers';
import { MAX_ATTUNED } from '@/engine/items';
import type {
  ActorRuntimeState,
  Character,
  EngineState,
  InventoryItem,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// E2E driver against an in-memory EngineState. Mutation semantics MUST
// match the DB applicator — keep this in lockstep with
// src/sessions/applicator.ts. Mirrors the pattern from inspiration-rest-loop
// and concentration-loop scenarios. Tracks the new attune/unattune ops.

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({ ...c })),
  };
  switch (m.op) {
    case 'attune': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const char = next.characters[idx]!;
      const cur = char.attunedItems ?? [];
      if (cur.includes(m.itemSlug)) break;
      next.characters[idx] = { ...char, attunedItems: [...cur, m.itemSlug] };
      break;
    }
    case 'unattune': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const char = next.characters[idx]!;
      const cur = char.attunedItems ?? [];
      if (!cur.includes(m.itemSlug)) break;
      next.characters[idx] = {
        ...char,
        attunedItems: cur.filter((s) => s !== m.itemSlug),
      };
      break;
    }
    default:
      break;
  }
  return next;
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function pcWithItems(opts: {
  id?: string;
  inventory?: InventoryItem[];
  attunedItems?: string[];
} = {}): Character {
  return {
    id: opts.id ?? 'pc1',
    name: opts.id === 'pc2' ? 'Lyra' : 'Tharion',
    level: 7,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 60,
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
    hitDiceMax: 7,
    hitDieSize: 10,
  };
}

function freshState(chars: Character[]): EngineState {
  const runtime: Record<string, ActorRuntimeState> = {};
  for (const c of chars) {
    runtime[c.id] = {
      actorId: c.id,
      hpCurrent: c.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
    };
  }
  return {
    characters: chars,
    combatActors: [],
    runtime,
    combat: null,
    scene: 'a vault of ancient magic',
  };
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

describe('E2E — attunement loop (PHB §10.1)', () => {
  it('PC attunes 3 items → 4th attune errors with attunement_cap_reached', () => {
    let state = freshState([
      pcWithItems({
        inventory: [
          { slug: 'cloak-of-protection', qty: 1, equipped: false },
          { slug: 'ring-of-protection', qty: 1, equipped: false },
          { slug: 'amulet-of-health', qty: 1, equipped: false },
          { slug: 'belt-of-giant-strength', qty: 1, equipped: false },
        ],
      }),
    ]);

    // 1st attunement.
    let r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ attuned: true });
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.attunedItems).toEqual(['cloak-of-protection']);

    // 2nd attunement.
    r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'ring-of-protection',
    });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);

    // 3rd attunement (at cap).
    r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'amulet-of-health',
    });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.attunedItems).toHaveLength(MAX_ATTUNED);

    // 4th attempt — must error.
    r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'belt-of-giant-strength',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('attunement_cap_reached');
    expect(r.mutations).toEqual([]);
    // State unchanged — still 3 attuned, none added.
    expect(state.characters[0]!.attunedItems).toEqual([
      'cloak-of-protection',
      'ring-of-protection',
      'amulet-of-health',
    ]);
  });

  it('PC unattunes one item → can then attune a new one', () => {
    let state = freshState([
      pcWithItems({
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
      }),
    ]);

    // 4th attune blocked by cap.
    const blocked = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'belt-of-giant-strength',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe('attunement_cap_reached');

    // Unattune the cloak (narrative: at the next long rest the player
    // intentionally releases the bond).
    const unattune = handleUnattune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });
    expect(unattune.ok).toBe(true);
    expect(unattune.data).toEqual({ unattuned: true });
    expect(unattune.mutations).toEqual([
      { op: 'unattune', characterId: 'pc1', itemSlug: 'cloak-of-protection' },
    ]);
    state = applyAll(state, unattune.mutations);
    expect(state.characters[0]!.attunedItems).toEqual([
      'ring-of-protection',
      'amulet-of-health',
    ]);

    // Now the 4th attune succeeds.
    const reattune = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'belt-of-giant-strength',
    });
    expect(reattune.ok).toBe(true);
    expect(reattune.data).toEqual({ attuned: true });
    state = applyAll(state, reattune.mutations);
    expect(state.characters[0]!.attunedItems).toEqual([
      'ring-of-protection',
      'amulet-of-health',
      'belt-of-giant-strength',
    ]);

    // And the cloak (now in inventory but not attuned) can be re-bonded
    // later, after another unattune to make room.
    const unattune2 = handleUnattune(state, {
      character: 'pc1',
      itemSlug: 'amulet-of-health',
    });
    state = applyAll(state, unattune2.mutations);
    const reattuneCloak = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });
    expect(reattuneCloak.ok).toBe(true);
    state = applyAll(state, reattuneCloak.mutations);
    expect(state.characters[0]!.attunedItems).toContain('cloak-of-protection');
    expect(state.characters[0]!.attunedItems).toHaveLength(MAX_ATTUNED);
  });

  it('PC tries to attune an item not in inventory → item_not_in_inventory', () => {
    const state = freshState([
      pcWithItems({
        // Inventory holds something else, but NOT the staff the PC is trying
        // to attune to.
        inventory: [
          { slug: 'cloak-of-protection', qty: 1, equipped: false },
        ],
        attunedItems: [],
      }),
    ]);

    const r = handleAttune(state, {
      character: 'pc1',
      itemSlug: 'staff-of-power',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('item_not_in_inventory');
    expect(r.mutations).toEqual([]);
    // attunedItems remains empty.
    expect(state.characters[0]!.attunedItems).toEqual([]);
  });

  it('Multiple PCs each track their own attunement list (independent caps)', () => {
    let state = freshState([
      pcWithItems({
        id: 'pc1',
        inventory: [
          { slug: 'cloak-of-protection', qty: 1, equipped: false },
          { slug: 'ring-of-protection', qty: 1, equipped: false },
          { slug: 'amulet-of-health', qty: 1, equipped: false },
        ],
      }),
      pcWithItems({
        id: 'pc2',
        inventory: [
          { slug: 'staff-of-the-magi', qty: 1, equipped: false },
          { slug: 'wand-of-fireballs', qty: 1, equipped: false },
          { slug: 'cloak-of-elvenkind', qty: 1, equipped: false },
        ],
      }),
    ]);

    // pc1 attunes all 3 of theirs.
    for (const slug of [
      'cloak-of-protection',
      'ring-of-protection',
      'amulet-of-health',
    ]) {
      const r = handleAttune(state, { character: 'pc1', itemSlug: slug });
      expect(r.ok).toBe(true);
      state = applyAll(state, r.mutations);
    }

    // pc2 attunes all 3 of theirs — not affected by pc1's cap.
    for (const slug of [
      'staff-of-the-magi',
      'wand-of-fireballs',
      'cloak-of-elvenkind',
    ]) {
      const r = handleAttune(state, { character: 'pc2', itemSlug: slug });
      expect(r.ok).toBe(true);
      state = applyAll(state, r.mutations);
    }

    expect(state.characters[0]!.attunedItems).toHaveLength(MAX_ATTUNED);
    expect(state.characters[1]!.attunedItems).toHaveLength(MAX_ATTUNED);
    expect(state.characters[0]!.attunedItems).toEqual([
      'cloak-of-protection',
      'ring-of-protection',
      'amulet-of-health',
    ]);
    expect(state.characters[1]!.attunedItems).toEqual([
      'staff-of-the-magi',
      'wand-of-fireballs',
      'cloak-of-elvenkind',
    ]);

    // pc1 unattuning does not affect pc2.
    const unattune = handleUnattune(state, {
      character: 'pc1',
      itemSlug: 'cloak-of-protection',
    });
    state = applyAll(state, unattune.mutations);
    expect(state.characters[0]!.attunedItems).toHaveLength(2);
    expect(state.characters[1]!.attunedItems).toHaveLength(MAX_ATTUNED);
  });

  it('TOOL_HANDLERS dispatch round-trip (attune + unattune) preserves state', () => {
    let state = freshState([
      pcWithItems({
        inventory: [
          { slug: 'ring-of-protection', qty: 1, equipped: false },
        ],
      }),
    ]);

    const a = TOOL_HANDLERS.attune!(state, {
      character: 'pc1',
      itemSlug: 'ring-of-protection',
    });
    expect(a.ok).toBe(true);
    state = applyAll(state, a.mutations);
    expect(state.characters[0]!.attunedItems).toEqual(['ring-of-protection']);

    // Unattune via dispatcher.
    const u = TOOL_HANDLERS.unattune!(state, {
      character: 'pc1',
      itemSlug: 'ring-of-protection',
    });
    expect(u.ok).toBe(true);
    expect(u.data).toEqual({ unattuned: true });
    state = applyAll(state, u.mutations);
    expect(state.characters[0]!.attunedItems).toEqual([]);

    // Re-attune again — should still work.
    const re = TOOL_HANDLERS.attune!(state, {
      character: 'pc1',
      itemSlug: 'ring-of-protection',
    });
    expect(re.ok).toBe(true);
    state = applyAll(state, re.mutations);
    expect(state.characters[0]!.attunedItems).toEqual(['ring-of-protection']);
  });
});
