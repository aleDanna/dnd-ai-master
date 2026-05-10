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
  InventoryItem,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// Mirrors the DB applicator's start/progress/complete/cancel semantics so
// this scenario can run without Postgres. The contract MUST track
// src/sessions/applicator.ts — see also tests/engine/scenarios/attunement-loop.

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
    ...state,
    runtime: { ...state.runtime },
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
      // Mirror the DB applicator: remove the project AND chain
      // add_inventory for the recipe slug (qty +1).
      const inv = next.characters[idx]!.inventory;
      const existing = inv.find((it) => it.slug === project.recipeSlug);
      const nextInv: InventoryItem[] = existing
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

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pcWithCrafting(opts: { inventory?: InventoryItem[] } = {}): Character {
  return {
    id: 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'wizard',
    raceSlug: 'human',
    backgroundSlug: 'sage',
    abilities: { STR: 12, DEX: 12, CON: 12, INT: 16, WIS: 12, CHA: 10 },
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
    inventory: opts.inventory ?? [{ slug: 'gp', qty: 250, equipped: false }],
    hitDiceMax: 5,
    hitDieSize: 6,
    craftingProjects: [],
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
    scene: 'a quiet smithy',
  };
}

// ─── Scenario ─────────────────────────────────────────────────────────────

describe('E2E — crafting loop (PHB §5 + DMG)', () => {
  it('walks a non-magical longsword from start to inventory across 30 days', () => {
    let state = freshState(pcWithCrafting());

    // 1. Start non-magical longsword crafting (price 15 gp) → 30 days, 8 gp
    //    (the helper uses ceil(P/2) which yields 8 — the pure helper test
    //    pins the exact arithmetic).
    const start = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'longsword',
      kind: 'item',
      itemPriceGp: 15,
      projectId: 'longsword-1',
    });
    expect(start.ok).toBe(true);
    expect(start.data?.project).toMatchObject({
      id: 'longsword-1',
      recipeSlug: 'longsword',
      kind: 'item',
      daysRemaining: 30,
      gpSpent: 0,
    });
    state = applyAll(state, start.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(1);

    // 2. Progress 10 days → 20 remaining
    const progress1 = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'longsword-1',
      daysSpent: 10,
      gpDelta: 4,
    });
    expect(progress1.ok).toBe(true);
    state = applyAll(state, progress1.mutations);
    expect(state.characters[0]!.craftingProjects![0]).toMatchObject({
      daysRemaining: 20,
      gpSpent: 4,
    });

    // Master cannot complete yet — not_ready.
    const tooEarly = handleCompleteCrafting(state, {
      character: 'pc1',
      projectId: 'longsword-1',
    });
    expect(tooEarly.ok).toBe(false);
    expect(tooEarly.error).toBe('not_ready');

    // 3. Progress 20 more days → 0 remaining
    const progress2 = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'longsword-1',
      daysSpent: 20,
      gpDelta: 4,
    });
    expect(progress2.ok).toBe(true);
    state = applyAll(state, progress2.mutations);
    expect(state.characters[0]!.craftingProjects![0]).toMatchObject({
      daysRemaining: 0,
      gpSpent: 8,
    });

    // 4. Complete → longsword in inventory + project gone
    const complete = handleCompleteCrafting(state, {
      character: 'pc1',
      projectId: 'longsword-1',
    });
    expect(complete.ok).toBe(true);
    state = applyAll(state, complete.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(0);
    expect(
      state.characters[0]!.inventory.find((i) => i.slug === 'longsword'),
    ).toMatchObject({ slug: 'longsword', qty: 1, equipped: false });
  });

  it('starts an uncommon magic item, cancels it halfway with no item added', () => {
    let state = freshState(pcWithCrafting());

    // 5. Start uncommon magic item → 20 days / 200 gp
    const start = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'wand-of-magic-missiles',
      kind: 'magic_item',
      rarity: 'uncommon',
      projectId: 'wand-1',
    });
    expect(start.ok).toBe(true);
    expect(start.data?.project).toMatchObject({
      id: 'wand-1',
      recipeSlug: 'wand-of-magic-missiles',
      kind: 'magic_item',
      daysRemaining: 20,
      gpSpent: 0,
    });
    state = applyAll(state, start.mutations);

    // Spend 9 days + commit 100 gp.
    const progress = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'wand-1',
      daysSpent: 9,
      gpDelta: 100,
    });
    state = applyAll(state, progress.mutations);
    expect(state.characters[0]!.craftingProjects![0]).toMatchObject({
      daysRemaining: 11,
      gpSpent: 100,
    });

    // 6. Cancel halfway → no item, project gone, no refund
    const cancel = handleCancelCrafting(state, {
      character: 'pc1',
      projectId: 'wand-1',
    });
    expect(cancel.ok).toBe(true);
    expect(cancel.data).toEqual({ cancelled: true });
    state = applyAll(state, cancel.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(0);
    expect(
      state.characters[0]!.inventory.find((i) => i.slug === 'wand-of-magic-missiles'),
    ).toBeUndefined();

    // Cancelling the same id again is permissive (cancelled:false).
    const reCancel = handleCancelCrafting(state, {
      character: 'pc1',
      projectId: 'wand-1',
    });
    expect(reCancel.ok).toBe(true);
    expect(reCancel.data).toEqual({ cancelled: false });
    expect(reCancel.mutations).toEqual([]);
  });

  it('starts an L3 spell scroll → 6 days / 250 gp', () => {
    let state = freshState(pcWithCrafting());

    // 7. Start scroll crafting (L3 spell) → 6 days, 250 gp
    const start = handleStartCrafting(state, {
      character: 'pc1',
      recipeSlug: 'scroll-of-fireball',
      kind: 'scroll',
      spellLevel: 3,
      projectId: 'scroll-1',
    });
    expect(start.ok).toBe(true);
    expect(start.data?.project).toMatchObject({
      id: 'scroll-1',
      recipeSlug: 'scroll-of-fireball',
      kind: 'scroll',
      daysRemaining: 6,
      gpSpent: 0,
    });
    state = applyAll(state, start.mutations);

    // Wrap the project in 3 progress chunks (all 6 days at once + 250 gp).
    const progress = handleProgressCrafting(state, {
      character: 'pc1',
      projectId: 'scroll-1',
      daysSpent: 6,
      gpDelta: 250,
    });
    state = applyAll(state, progress.mutations);
    expect(state.characters[0]!.craftingProjects![0]).toMatchObject({
      daysRemaining: 0,
      gpSpent: 250,
    });

    const complete = handleCompleteCrafting(state, {
      character: 'pc1',
      projectId: 'scroll-1',
    });
    expect(complete.ok).toBe(true);
    state = applyAll(state, complete.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(0);
    expect(
      state.characters[0]!.inventory.find((i) => i.slug === 'scroll-of-fireball'),
    ).toMatchObject({ slug: 'scroll-of-fireball', qty: 1, equipped: false });
  });

  it('TOOL_HANDLERS dispatch round-trip mirrors the direct-handler flow', () => {
    let state = freshState(pcWithCrafting());

    const start = TOOL_HANDLERS.start_crafting!(state, {
      character: 'pc1',
      recipeSlug: 'potion-of-healing',
      kind: 'potion',
      spellLevel: 1,
      projectId: 'potion-1',
    });
    expect(start.ok).toBe(true);
    state = applyAll(state, start.mutations);
    expect(state.characters[0]!.craftingProjects![0]).toMatchObject({
      kind: 'potion',
      daysRemaining: 4, // common (≤ L1)
      gpSpent: 0,
    });

    // Progress 4 days at once.
    const p = TOOL_HANDLERS.progress_crafting!(state, {
      character: 'pc1',
      projectId: 'potion-1',
      daysSpent: 4,
      gpDelta: 50,
    });
    state = applyAll(state, p.mutations);
    expect(state.characters[0]!.craftingProjects![0]!.daysRemaining).toBe(0);

    // Complete via the dispatcher.
    const c = TOOL_HANDLERS.complete_crafting!(state, {
      character: 'pc1',
      projectId: 'potion-1',
    });
    expect(c.ok).toBe(true);
    state = applyAll(state, c.mutations);
    expect(state.characters[0]!.craftingProjects).toHaveLength(0);
    expect(
      state.characters[0]!.inventory.find((i) => i.slug === 'potion-of-healing'),
    ).toMatchObject({ slug: 'potion-of-healing', qty: 1, equipped: false });
  });
});
