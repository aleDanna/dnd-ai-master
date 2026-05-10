import { describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '@/engine';
import {
  combinedCasterLevel,
  spellSlotsForCasterLevel,
} from '@/engine/multiclass';
import type {
  Character,
  ClassLevel,
  EngineState,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// E2E driver for multiclass scenarios. Mirrors the DB applicator's
// `add_class_level` semantics: append a fresh entry, or increment an
// existing one; recompute the total `level`; align `classSlug` to
// classes[0].slug. Other ops are stubbed — the multiclass loop only
// touches add_class_level.
function applyMutation(state: EngineState, m: Mutation): EngineState {
  if (m.op !== 'add_class_level') return state;

  const idx = state.characters.findIndex((c) => c.id === m.characterId);
  if (idx < 0) return state;
  const char = state.characters[idx]!;

  // Hydrate: backfill from classSlug+level if classes[] is empty.
  let current: ClassLevel[] =
    Array.isArray(char.classes) && char.classes.length > 0
      ? char.classes.map((cl) => ({ ...cl }))
      : [{ slug: char.classSlug, level: char.level }];

  const existingIdx = current.findIndex((cl) => cl.slug === m.classSlug);
  let next: ClassLevel[];
  if (existingIdx >= 0) {
    const existing = current[existingIdx]!;
    const updated: ClassLevel = { ...existing, level: existing.level + 1 };
    if (m.subclass) updated.subclass = m.subclass;
    next = current.map((cl, i) => (i === existingIdx ? updated : cl));
  } else {
    const fresh: ClassLevel = { slug: m.classSlug, level: 1 };
    if (m.subclass) fresh.subclass = m.subclass;
    next = [...current, fresh];
  }

  const newTotalLevel = next.reduce((sum, cl) => sum + Math.max(1, cl.level), 0);
  const newPrimary = next[0]?.slug ?? char.classSlug;

  const updatedChar: Character = {
    ...char,
    classes: next,
    classSlug: newPrimary,
    level: newTotalLevel,
  };
  const characters = state.characters.map((c, i) => (i === idx ? updatedChar : c));
  return { ...state, characters };
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

/**
 * Build a fresh test state. The character starts as a plain class-N PC
 * (no `classes` array) so the in-memory applicator backfills the array
 * from `classSlug` + `level` on the first add_class_level — same path
 * production characters take.
 */
function makeState(opts: {
  classSlug: string;
  level: number;
  abilities: Character['abilities'];
  classes?: ClassLevel[];
}): EngineState {
  const pc: Character = {
    id: 'pc1',
    name: 'Test PC',
    level: opts.level,
    xp: 0,
    classSlug: opts.classSlug,
    classes: opts.classes,
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: opts.abilities,
    proficiencyBonus: opts.level >= 5 ? 3 : 2,
    hpMax: 30,
    ac: 16,
    speed: 30,
    proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: opts.level,
    hitDieSize: 10,
  };
  return {
    characters: [pc],
    combatActors: [],
    runtime: {
      pc1: {
        actorId: 'pc1',
        hpCurrent: 30,
        tempHp: 0,
        deathSaves: { successes: 0, failures: 0 },
        conditions: [],
      },
    },
    combat: null,
    scene: 'multiclass demo',
  };
}

describe('multiclass loop (PHB §2.5)', () => {
  it('Scenario 1: Fighter STR 16 INT 10 → add Wizard fails (INT < 13)', () => {
    const state = makeState({
      classSlug: 'fighter',
      level: 5,
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    const r = TOOL_HANDLERS['add_class_level']!(state, {
      character: 'pc1',
      classSlug: 'wizard',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('multiclass_prereqs_not_met');
    // Mutation list is empty — the PC's classes/level remain unchanged.
    expect(r.mutations).toEqual([]);
    const after = applyAll(state, r.mutations);
    expect(after.characters[0]!.level).toBe(5);
    expect(after.characters[0]!.classes).toBeUndefined();
  });

  it('Scenario 2: Fighter STR 16 INT 13 → add Wizard succeeds; classes = [fighter, wizard]', () => {
    const state = makeState({
      classSlug: 'fighter',
      level: 5,
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    const r = TOOL_HANDLERS['add_class_level']!(state, {
      character: 'pc1',
      classSlug: 'wizard',
    });
    expect(r.ok).toBe(true);
    const after = applyAll(state, r.mutations);
    expect(after.characters[0]!.classes).toEqual([
      { slug: 'fighter', level: 5 },
      { slug: 'wizard', level: 1 },
    ]);
    expect(after.characters[0]!.classSlug).toBe('fighter');
    expect(after.characters[0]!.level).toBe(6);
  });

  it('Scenario 3: Bard 5 + Wizard 5 → combined caster level 10 → matches level-10 full-caster slots', () => {
    const classes: ClassLevel[] = [
      { slug: 'bard', level: 5 },
      { slug: 'wizard', level: 5 },
    ];
    const cl = combinedCasterLevel(classes);
    expect(cl).toBe(10);
    const slots = spellSlotsForCasterLevel(cl);
    // PHB §13.1 row 10: 4/3/3/3/2 across spell levels 1..5.
    expect(slots).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 });
  });

  it('Scenario 4: Paladin 5 + Wizard 5 → combined caster level 7 → matches level-7 slots', () => {
    const classes: ClassLevel[] = [
      { slug: 'paladin', level: 5 },
      { slug: 'wizard', level: 5 },
    ];
    // floor(5/2) = 2 + 5 = 7
    const cl = combinedCasterLevel(classes);
    expect(cl).toBe(7);
    const slots = spellSlotsForCasterLevel(cl);
    // PHB §13.1 row 7: 4/3/3/1.
    expect(slots).toEqual({ 1: 4, 2: 3, 3: 3, 4: 1 });
  });

  it('Scenario 5: Fighter (Eldritch Knight) 5 + Wizard 5 → combined level 6 → matches level-6 slots', () => {
    const classes: ClassLevel[] = [
      { slug: 'fighter', level: 5, subclass: 'eldritch-knight' },
      { slug: 'wizard', level: 5 },
    ];
    // floor(5/3) = 1 + 5 = 6
    const cl = combinedCasterLevel(classes);
    expect(cl).toBe(6);
    const slots = spellSlotsForCasterLevel(cl);
    // PHB §13.1 row 6: 4/3/3.
    expect(slots).toEqual({ 1: 4, 2: 3, 3: 3 });
  });

  it('Scenario 6: Warlock 5 + Wizard 5 → wizard contributes 5; warlock pact slots SEPARATE', () => {
    const classes: ClassLevel[] = [
      { slug: 'warlock', level: 5 },
      { slug: 'wizard', level: 5 },
    ];
    // Warlock pact slots are NOT combined; only the wizard 5 levels count.
    const cl = combinedCasterLevel(classes);
    expect(cl).toBe(5);
    const slots = spellSlotsForCasterLevel(cl);
    // PHB §13.1 row 5: 4/3/2.
    expect(slots).toEqual({ 1: 4, 2: 3, 3: 2 });
  });

  it('Bonus: re-leveling the starting class with applied mutation increments level total', () => {
    const state = makeState({
      classSlug: 'fighter',
      level: 5,
      classes: [{ slug: 'fighter', level: 5 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    const r = TOOL_HANDLERS['add_class_level']!(state, {
      character: 'pc1',
      classSlug: 'fighter',
    });
    expect(r.ok).toBe(true);
    const after = applyAll(state, r.mutations);
    expect(after.characters[0]!.classes).toEqual([{ slug: 'fighter', level: 6 }]);
    expect(after.characters[0]!.level).toBe(6);
  });

  it('Bonus: subclass is persisted on the entry when supplied', () => {
    const state = makeState({
      classSlug: 'fighter',
      level: 2,
      classes: [{ slug: 'fighter', level: 2 }],
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    });
    const r = TOOL_HANDLERS['add_class_level']!(state, {
      character: 'pc1',
      classSlug: 'fighter',
      subclass: 'eldritch-knight',
    });
    expect(r.ok).toBe(true);
    const after = applyAll(state, r.mutations);
    expect(after.characters[0]!.classes).toEqual([
      { slug: 'fighter', level: 3, subclass: 'eldritch-knight' },
    ]);
  });

  it('Bonus: invalid class slug returns error and never mutates', () => {
    const state = makeState({
      classSlug: 'fighter',
      level: 5,
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 13, WIS: 10, CHA: 10 },
    });
    const r = TOOL_HANDLERS['add_class_level']!(state, {
      character: 'pc1',
      classSlug: 'mystic',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_class_slug');
    const after = applyAll(state, r.mutations);
    expect(after.characters[0]!.level).toBe(5);
  });

  it('Bonus: paladin 1 (half caster L1) contributes 0 → matches PHB §13.2 floor rule', () => {
    expect(combinedCasterLevel([{ slug: 'paladin', level: 1 }])).toBe(0);
    expect(spellSlotsForCasterLevel(0)).toEqual({});
  });

  it('Bonus: Eldritch Knight at level 2 still contributes 0 (third caster threshold L3)', () => {
    expect(
      combinedCasterLevel([{ slug: 'fighter', level: 2, subclass: 'eldritch-knight' }]),
    ).toBe(0);
  });
});
