import { describe, it, expect } from 'vitest';
import { castSpell } from '@/engine/spells';
import { makeSeededRng } from '@/engine/rand';
import { newTurnState } from '@/engine/combat/turn-state';
import type { Character, CombatActor, ActorRuntimeState, ConcentrationState, TurnState } from '@/engine/types';

function pcCaster(overrides: { spellsKnown?: string[] } = {}): Character {
  return {
    id: 'pc1', name: 'Lyra', level: 5, xp: 0,
    classSlug: 'wizard', raceSlug: 'high-elf', backgroundSlug: 'sage',
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
    proficiencyBonus: 3, hpMax: 28, ac: 12, speed: 30,
    proficiencies: { saves: ['INT', 'WIS'], skills: ['Arcana', 'History'], expertise: [], weapons: [], armor: [], tools: [], languages: ['Common', 'Elvish'] },
    spellcasting: {
      ability: 'INT',
      spellSaveDC: 15,
      spellAttackBonus: 7,
      slotsMax: { 1: 4, 2: 3, 3: 2 },
      spellsKnown: overrides.spellsKnown ?? ['magic-missile', 'fireball'],
      spellsPrepared: [],
    },
    features: [], inventory: [], hitDiceMax: 5, hitDieSize: 6,
  };
}

function runtimeFor(
  caster: Character,
  overrides: {
    spellSlotsUsed?: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
    concentratingOn?: ConcentrationState;
    turnState?: TurnState;
  } = {},
): ActorRuntimeState {
  return {
    actorId: caster.id,
    hpCurrent: caster.hpMax,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    conditions: [],
    spellSlotsUsed: overrides.spellSlotsUsed ?? {},
    resourcesUsed: {},
    ...(overrides.concentratingOn ? { concentratingOn: overrides.concentratingOn } : {}),
    ...(overrides.turnState ? { turnState: overrides.turnState } : {}),
  };
}

const wizard: Character = {
  id: 'pc1', name: 'Lyra', level: 5, xp: 0,
  classSlug: 'wizard', raceSlug: 'high-elf', backgroundSlug: 'sage',
  abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 28, ac: 12, speed: 30,
  proficiencies: { saves: ['INT', 'WIS'], skills: ['Arcana', 'History'], expertise: [], weapons: [], armor: [], tools: [], languages: ['Common', 'Elvish'] },
  spellcasting: { ability: 'INT', spellSaveDC: 15, spellAttackBonus: 7, slotsMax: { 1: 4, 2: 3, 3: 2 }, spellsKnown: ['magic-missile', 'fireball', 'healing-word', 'light', 'fire-bolt', 'shield'], spellsPrepared: [] },
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

  it('cantrip (slotLevel 0) succeeds without consuming a slot', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'light', slotLevel: 0, targets: [] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(false);
  });

  it('cantrip ignores empty slotsMax at level 0 (no no_slot error)', () => {
    const noSlots: Character = {
      ...wizard,
      spellcasting: { ...wizard.spellcasting!, slotsMax: {} },
    };
    const r = castSpell({ caster: noSlots, runtime: wizardRuntime, spellSlug: 'fire-bolt', slotLevel: 0, targets: [{ id: 'm1', ac: 10 }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
  });

  it('leveled spell without a specialised handler succeeds and consumes a slot', () => {
    // `shield` has no entry in SPELL_HANDLERS — should still succeed (master narrates,
    // calls follow-up tools as needed) and consume the slot at the chosen level.
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'shield', slotLevel: 1, targets: [{ id: 'pc1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
    expect(r.mutations.filter((m) => m.op === 'apply_damage').length).toBe(0);
  });

  it('still enforces slot availability for leveled casts of unimplemented spells', () => {
    const exhausted: ActorRuntimeState = { ...wizardRuntime, spellSlotsUsed: { 1: 4 } };
    const r = castSpell({ caster: wizard, runtime: exhausted, spellSlug: 'shield', slotLevel: 1, targets: [{ id: 'pc1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_slot');
  });
});

describe('castSpell — archetype factory dispatch', () => {
  it('fire-bolt dispatches to attack_damage archetype', () => {
    const caster = pcCaster({ spellsKnown: ['fire-bolt'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
    }, () => 0.95);
    expect(result.ok).toBe(true);
    expect(result.data?.effects).toContain('attack-hit');
  });

  it('cure-wounds dispatches to heal archetype', () => {
    const caster = pcCaster({ spellsKnown: ['cure-wounds'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'cure-wounds',
      slotLevel: 1,
      targets: [{ id: 'pc1' }],
    }, () => 0.5);
    const heal = result.mutations.find((m) => m.op === 'heal');
    expect(heal).toBeDefined();
  });

  it('unknown spell with no binding still ok (narrative cast)', () => {
    const caster = pcCaster({ spellsKnown: ['some-homebrew'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'some-homebrew',
      slotLevel: 1,
      targets: [],
    }, () => 0.5);
    expect(result.ok).toBe(true);
    expect(result.mutations.find((m) => m.op === 'use_spell_slot')).toBeDefined();
  });
});

describe('castSpell — concentration', () => {
  it('casting bless emits set_concentration mutation', () => {
    const caster = pcCaster({ spellsKnown: ['bless'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'bless',
      slotLevel: 1,
      targets: [{ id: 'pc1' }, { id: 'pc2' }, { id: 'pc3' }],
      currentRound: 1,
    }, () => 0.5);
    const setCon = result.mutations.find((m) => m.op === 'set_concentration');
    expect(setCon).toBeDefined();
    if (setCon?.op === 'set_concentration') {
      expect(setCon.spellSlug).toBe('bless');
      expect(setCon.slotLevel).toBe(1);
      expect(setCon.startedRound).toBe(1);
    }
  });

  it('casting a new concentration spell while already concentrating emits break first', () => {
    const caster = pcCaster({ spellsKnown: ['bless', 'hold-person'] });
    const runtime = runtimeFor(caster, {
      spellSlotsUsed: { 1: 0, 2: 0 },
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = castSpell({
      caster,
      runtime,
      spellSlug: 'hold-person',
      slotLevel: 2,
      targets: [{ id: 'm1' }],
      currentRound: 3,
    }, () => 0.5);
    const ops = result.mutations.map((m) => m.op);
    expect(ops).toContain('break_concentration');
    expect(ops).toContain('set_concentration');
    expect(ops.indexOf('break_concentration')).toBeLessThan(ops.indexOf('set_concentration'));
  });

  it('casting a non-concentration spell does NOT emit set_concentration', () => {
    const caster = pcCaster({ spellsKnown: ['fire-bolt'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
    }, () => 0.5);
    const setCon = result.mutations.find((m) => m.op === 'set_concentration');
    expect(setCon).toBeUndefined();
  });
});

describe('castSpell — ritual', () => {
  it('asRitual: true with ritual-flagged spell skips slot consumption', () => {
    const caster = pcCaster({ spellsKnown: ['detect-magic'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'detect-magic',
      slotLevel: 1,
      targets: [],
      asRitual: true,
      spellMeta: { ritual: true, concentration: false },
    }, () => 0.5);
    expect(result.ok).toBe(true);
    const slotMut = result.mutations.find((m) => m.op === 'use_spell_slot');
    expect(slotMut).toBeUndefined();
    expect(result.data?.effects).toContain('ritual');
  });

  it('asRitual: true with non-ritual spell errors out', () => {
    const caster = pcCaster({ spellsKnown: ['fire-bolt'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1' }],
      asRitual: true,
      spellMeta: { ritual: false, concentration: false },
    }, () => 0.5);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a ritual/i);
  });

  it('asRitual: false on a ritual-eligible spell consumes slot normally', () => {
    const caster = pcCaster({ spellsKnown: ['detect-magic'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'detect-magic',
      slotLevel: 1,
      targets: [],
      asRitual: false,
      spellMeta: { ritual: true, concentration: false },
    }, () => 0.5);
    const slotMut = result.mutations.find((m) => m.op === 'use_spell_slot');
    expect(slotMut).toBeDefined();
  });
});

describe('castSpell — action economy integration', () => {
  it('casting fire-bolt (1 action) emits consume_action(action)', () => {
    const c = pcCaster({ spellsKnown: ['fire-bolt'] });
    const r = castSpell({
      caster: c,
      runtime: runtimeFor(c, { turnState: newTurnState() }),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
      spellMeta: { castingTime: '1 action' },
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const consume = r.mutations.find((m) => m.op === 'consume_action');
    expect(consume).toMatchObject({ kind: 'action' });
  });

  it('casting healing-word (1 bonus action) emits consume_action(bonus)', () => {
    const c = pcCaster({ spellsKnown: ['healing-word'] });
    const r = castSpell({
      caster: c,
      runtime: runtimeFor(c, { spellSlotsUsed: { 1: 0 }, turnState: newTurnState() }),
      spellSlug: 'healing-word',
      slotLevel: 1,
      targets: [{ id: 'pc1' }],
      spellMeta: { castingTime: '1 bonus action' },
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const consume = r.mutations.find((m) => m.op === 'consume_action');
    expect(consume).toMatchObject({ kind: 'bonus' });
  });

  it('casting shield (1 reaction) emits consume_action(reaction)', () => {
    const c = pcCaster({ spellsKnown: ['shield'] });
    const r = castSpell({
      caster: c,
      runtime: runtimeFor(c, { spellSlotsUsed: { 1: 0 }, turnState: newTurnState() }),
      spellSlug: 'shield',
      slotLevel: 1,
      targets: [{ id: 'pc1' }],
      spellMeta: { castingTime: '1 reaction' },
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const consume = r.mutations.find((m) => m.op === 'consume_action');
    expect(consume).toMatchObject({ kind: 'reaction' });
  });

  it('casting alarm (1 minute) → no consume_action mutation (out of combat)', () => {
    const c = pcCaster({ spellsKnown: ['alarm'] });
    const r = castSpell({
      caster: c,
      runtime: runtimeFor(c, { spellSlotsUsed: { 1: 0 }, turnState: newTurnState() }),
      spellSlug: 'alarm',
      slotLevel: 1,
      targets: [],
      spellMeta: { castingTime: '1 minute' },
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const consume = r.mutations.find((m) => m.op === 'consume_action');
    expect(consume).toBeUndefined();
  });

  it('no turnState → no consume_action mutation (out of combat / backward compat)', () => {
    const c = pcCaster({ spellsKnown: ['fire-bolt'] });
    const r = castSpell({
      caster: c,
      runtime: runtimeFor(c),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
      spellMeta: { castingTime: '1 action' },
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const consume = r.mutations.find((m) => m.op === 'consume_action');
    expect(consume).toBeUndefined();
  });

  it('errors action_already_used when action consumed and trying 1-action spell', () => {
    const c = pcCaster({ spellsKnown: ['fire-bolt'] });
    const runtime = runtimeFor(c, { turnState: { ...newTurnState(), actionUsed: true } });
    const r = castSpell({
      caster: c, runtime, spellSlug: 'fire-bolt', slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
      spellMeta: { castingTime: '1 action' },
    }, () => 0.5);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('action_already_used');
  });

  it('errors bonus_already_used when bonus consumed and trying bonus-action spell', () => {
    const c = pcCaster({ spellsKnown: ['healing-word'] });
    const runtime = runtimeFor(c, {
      spellSlotsUsed: { 1: 0 },
      turnState: { ...newTurnState(), bonusUsed: true },
    });
    const r = castSpell({
      caster: c, runtime, spellSlug: 'healing-word', slotLevel: 1, targets: [{ id: 'pc1' }],
      spellMeta: { castingTime: '1 bonus action' },
    }, () => 0.5);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bonus_already_used');
  });

  it('PHB §8.5: bonus-action spell already cast → next leveled spell errors', () => {
    // Step 1: cast healing-word (bonus action); should succeed
    const c = pcCaster({ spellsKnown: ['healing-word', 'cure-wounds'] });
    let runtime = runtimeFor(c, { spellSlotsUsed: { 1: 0 }, turnState: newTurnState() });
    const r1 = castSpell({
      caster: c, runtime, spellSlug: 'healing-word', slotLevel: 1, targets: [{ id: 'pc1' }],
      spellMeta: { castingTime: '1 bonus action' },
    }, () => 0.5);
    expect(r1.ok).toBe(true);

    // Now simulate that the bonus_used flag is set (the applicator would have set it)
    runtime = { ...runtime, turnState: { ...newTurnState(), bonusUsed: true } };

    // Step 2: try to cast cure-wounds (1 action, leveled) → bonus_action_spell_rule
    const r2 = castSpell({
      caster: c, runtime, spellSlug: 'cure-wounds', slotLevel: 1, targets: [{ id: 'pc1' }],
      spellMeta: { castingTime: '1 action' },
    }, () => 0.5);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('bonus_action_spell_rule');
  });

  it('PHB §8.5: bonus-action spell already cast → cantrip with 1 action casting time IS allowed', () => {
    const c = pcCaster({ spellsKnown: ['fire-bolt'] });
    const runtime = runtimeFor(c, { turnState: { ...newTurnState(), bonusUsed: true } });
    const r = castSpell({
      caster: c, runtime, spellSlug: 'fire-bolt', slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
      spellMeta: { castingTime: '1 action' },
    }, () => 0.5);
    expect(r.ok).toBe(true);  // cantrip exception
  });
});
