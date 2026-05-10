import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleCancelCrafting,
  handleCompleteCrafting,
  handleProgressCrafting,
  handleStartCrafting,
} from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  CraftingProject,
  EngineState,
  Mutation,
} from '@/engine/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pcWithCrafting(opts: { projects?: CraftingProject[] } = {}): Character {
  return {
    id: 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'wizard',
    raceSlug: 'human',
    backgroundSlug: 'sage',
    abilities: { STR: 10, DEX: 12, CON: 12, INT: 16, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 28,
    ac: 12,
    speed: 30,
    proficiencies: {
      saves: ['INT', 'WIS'],
      skills: ['Arcana', 'History'],
      expertise: [],
      weapons: ['Simple'],
      armor: [],
      tools: ["Smith's Tools"],
      languages: ['Common'],
    },
    spellcasting: null,
    features: [],
    inventory: [{ slug: 'gp', qty: 100, equipped: false }],
    hitDiceMax: 5,
    hitDieSize: 6,
    craftingProjects: opts.projects ?? [],
  };
}

function freshState(char: Character): EngineState {
  const runtime: Record<string, ActorRuntimeState> = {
    [char.id]: {
      actorId: char.id,
      hpCurrent: char.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
    },
  };
  return {
    characters: [char],
    combatActors: [],
    runtime,
    combat: null,
    scene: 'a quiet workshop',
  };
}

/** In-memory applicator for a single character (mirrors src/sessions/applicator.ts). */
function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
    ...state,
    characters: state.characters.map((c) => ({
      ...c,
      craftingProjects: c.craftingProjects ? [...c.craftingProjects] : [],
      inventory: [...c.inventory],
    })),
  };
  switch (m.op) {
    case 'start_crafting': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.craftingProjects ?? [];
      if (cur.some((p) => p.id === m.project.id)) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        craftingProjects: [...cur, m.project],
      };
      break;
    }
    case 'progress_crafting': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.craftingProjects ?? [];
      const pIdx = cur.findIndex((p) => p.id === m.projectId);
      if (pIdx < 0) break;
      const project = cur[pIdx]!;
      const updated: CraftingProject = {
        ...project,
        daysRemaining: Math.max(0, project.daysRemaining - m.daysSpent),
        gpSpent: project.gpSpent + (m.gpDelta ?? 0),
      };
      next.characters[idx] = {
        ...next.characters[idx]!,
        craftingProjects: cur.map((p, i) => (i === pIdx ? updated : p)),
      };
      break;
    }
    case 'complete_crafting': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.craftingProjects ?? [];
      const project = cur.find((p) => p.id === m.projectId);
      if (!project || project.daysRemaining > 0) break;
      const inv = next.characters[idx]!.inventory;
      const existing = inv.find((it) => it.slug === project.recipeSlug);
      const nextInv = existing
        ? inv.map((it) =>
            it.slug === project.recipeSlug ? { ...it, qty: it.qty + 1 } : it,
          )
        : [...inv, { slug: project.recipeSlug, qty: 1, equipped: false }];
      next.characters[idx] = {
        ...next.characters[idx]!,
        craftingProjects: cur.filter((p) => p.id !== project.id),
        inventory: nextInv,
      };
      break;
    }
    case 'cancel_crafting': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.craftingProjects ?? [];
      next.characters[idx] = {
        ...next.characters[idx]!,
        craftingProjects: cur.filter((p) => p.id !== m.projectId),
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

// ─── handleStartCrafting ──────────────────────────────────────────────────

describe('handleStartCrafting', () => {
  it("emits start_crafting for kind='item' with computed days/gp", () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'longsword',
      kind: 'item',
      itemPriceGp: 15,
      projectId: 'p1',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.project).toMatchObject({
      id: 'p1',
      recipeSlug: 'longsword',
      kind: 'item',
      daysRemaining: 30,
      gpSpent: 0,
    });
    expect(r.mutations).toEqual([
      {
        op: 'start_crafting',
        characterId: 'pc1',
        project: r.data!.project,
      },
    ]);
  });

  it("emits start_crafting for kind='magic_item' with rarity tier", () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'wand-of-sleep',
      kind: 'magic_item',
      rarity: 'uncommon',
      projectId: 'p2',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.project.daysRemaining).toBe(20);
  });

  it("emits start_crafting for kind='scroll' L3 → 6 days / 250 gp tracked", () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'scroll-of-fireball',
      kind: 'scroll',
      spellLevel: 3,
      projectId: 'p3',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.project.daysRemaining).toBe(6);
  });

  it("emits start_crafting for kind='potion' L1 → common (4 / 50)", () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'potion-of-healing',
      kind: 'potion',
      spellLevel: 1,
      projectId: 'p4',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.project.daysRemaining).toBe(4);
  });

  it('errors with unknown_character on missing PC', () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'ghost',
      recipeSlug: 'longsword',
      kind: 'item',
      itemPriceGp: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });

  it('errors with invalid_recipe_slug on empty slug', () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: '',
      kind: 'item',
      itemPriceGp: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_recipe_slug');
  });

  it('errors with invalid_kind on unknown kind', () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'longsword',
      // @ts-expect-error invalid kind on purpose
      kind: 'weapon',
      itemPriceGp: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_kind');
  });

  it("errors with invalid_rarity on missing rarity for kind='magic_item'", () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'wand-of-sleep',
      kind: 'magic_item',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_rarity');
  });

  it("errors with invalid_spell_level on missing level for kind='scroll'", () => {
    const state = freshState(pcWithCrafting());
    const r = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'scroll-of-fireball',
      kind: 'scroll',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_spell_level');
  });

  it('generates a fresh project id when projectId is omitted', () => {
    const state = freshState(pcWithCrafting());
    const a = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'longsword',
      kind: 'item',
      itemPriceGp: 15,
    });
    const b = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'longsword',
      kind: 'item',
      itemPriceGp: 15,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.data!.project.id).toBeTruthy();
    expect(b.data!.project.id).toBeTruthy();
    expect(a.data!.project.id).not.toBe(b.data!.project.id);
  });
});

// ─── handleProgressCrafting ──────────────────────────────────────────────

describe('handleProgressCrafting', () => {
  function withProject(): EngineState {
    return freshState(
      pcWithCrafting({
        projects: [
          {
            id: 'p1',
            recipeSlug: 'longsword',
            kind: 'item',
            daysRemaining: 30,
            gpSpent: 0,
          },
        ],
      }),
    );
  }

  it('emits progress_crafting with normalised inputs', () => {
    const state = withProject();
    const r = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'p1',
      daysSpent: 10,
      gpDelta: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'progress_crafting',
        characterId: 'pc1',
        projectId: 'p1',
        daysSpent: 10,
        gpDelta: 4,
      },
    ]);
  });

  it('errors with unknown_project when id is unknown', () => {
    const state = withProject();
    const r = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'nope',
      daysSpent: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_project');
  });

  it('errors with invalid_days on negative input', () => {
    const state = withProject();
    const r = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'p1',
      daysSpent: -5,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_days');
  });
});

// ─── handleCompleteCrafting ──────────────────────────────────────────────

describe('handleCompleteCrafting', () => {
  it('emits complete_crafting when daysRemaining=0', () => {
    const state = freshState(
      pcWithCrafting({
        projects: [
          {
            id: 'p1',
            recipeSlug: 'longsword',
            kind: 'item',
            daysRemaining: 0,
            gpSpent: 8,
          },
        ],
      }),
    );
    const r = handleCompleteCrafting(state, {
      character: 'pc1',
      projectId: 'p1',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'complete_crafting', characterId: 'pc1', projectId: 'p1' },
    ]);
  });

  it('errors with not_ready when daysRemaining > 0', () => {
    const state = freshState(
      pcWithCrafting({
        projects: [
          {
            id: 'p1',
            recipeSlug: 'longsword',
            kind: 'item',
            daysRemaining: 5,
            gpSpent: 0,
          },
        ],
      }),
    );
    const r = handleCompleteCrafting(state, {
      character: 'pc1',
      projectId: 'p1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_ready');
  });

  it('errors with unknown_project for missing id', () => {
    const state = freshState(pcWithCrafting());
    const r = handleCompleteCrafting(state, {
      character: 'pc1',
      projectId: 'absent',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_project');
  });
});

// ─── handleCancelCrafting ────────────────────────────────────────────────

describe('handleCancelCrafting', () => {
  it('emits cancel_crafting when project exists', () => {
    const state = freshState(
      pcWithCrafting({
        projects: [
          {
            id: 'p1',
            recipeSlug: 'wand-of-sleep',
            kind: 'magic_item',
            daysRemaining: 18,
            gpSpent: 100,
          },
        ],
      }),
    );
    const r = handleCancelCrafting(state, { character: 'pc1', projectId: 'p1' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ cancelled: true });
    expect(r.mutations).toEqual([
      { op: 'cancel_crafting', characterId: 'pc1', projectId: 'p1' },
    ]);
  });

  it('returns cancelled:false (no mutation) when id is absent', () => {
    const state = freshState(pcWithCrafting());
    const r = handleCancelCrafting(state, { character: 'pc1', projectId: 'absent' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ cancelled: false });
    expect(r.mutations).toEqual([]);
  });
});

// ─── TOOL_HANDLERS dispatch round-trip ────────────────────────────────────

describe('TOOL_HANDLERS dispatch (start → progress → complete)', () => {
  it('drives a project from start to complete and adds the item to inventory', () => {
    let state = freshState(pcWithCrafting());

    // Start
    const start = TOOL_HANDLERS.start_crafting!(state, {
      character: 'pc1',
      recipeSlug: 'longsword',
      kind: 'item',
      itemPriceGp: 15,
      projectId: 'fixed-id-1',
    });
    expect(start.ok).toBe(true);
    state = applyAll(state, start.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(1);

    // Progress 10 days
    const p1 = TOOL_HANDLERS.progress_crafting!(state, {
      character: 'pc1',
      projectId: 'fixed-id-1',
      daysSpent: 10,
    });
    expect(p1.ok).toBe(true);
    state = applyAll(state, p1.mutations);
    expect(state.characters[0]!.craftingProjects![0]!.daysRemaining).toBe(20);

    // Progress 20 more days
    const p2 = TOOL_HANDLERS.progress_crafting!(state, {
      character: 'pc1',
      projectId: 'fixed-id-1',
      daysSpent: 20,
      gpDelta: 8,
    });
    expect(p2.ok).toBe(true);
    state = applyAll(state, p2.mutations);
    expect(state.characters[0]!.craftingProjects![0]!.daysRemaining).toBe(0);
    expect(state.characters[0]!.craftingProjects![0]!.gpSpent).toBe(8);

    // Complete
    const complete = TOOL_HANDLERS.complete_crafting!(state, {
      character: 'pc1',
      projectId: 'fixed-id-1',
    });
    expect(complete.ok).toBe(true);
    state = applyAll(state, complete.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(0);
    expect(
      state.characters[0]!.inventory.find((i) => i.slug === 'longsword'),
    ).toMatchObject({ slug: 'longsword', qty: 1, equipped: false });
  });

  it('TOOL_HANDLERS.cancel_crafting drops the project without an item', () => {
    let state = freshState(pcWithCrafting());

    const start = TOOL_HANDLERS.start_crafting!(state, {
      character: 'pc1',
      recipeSlug: 'wand-of-sleep',
      kind: 'magic_item',
      rarity: 'uncommon',
      projectId: 'fixed-id-2',
    });
    state = applyAll(state, start.mutations);

    const cancel = TOOL_HANDLERS.cancel_crafting!(state, {
      character: 'pc1',
      projectId: 'fixed-id-2',
    });
    expect(cancel.ok).toBe(true);
    state = applyAll(state, cancel.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(0);
    expect(
      state.characters[0]!.inventory.find((i) => i.slug === 'wand-of-sleep'),
    ).toBeUndefined();
  });
});
