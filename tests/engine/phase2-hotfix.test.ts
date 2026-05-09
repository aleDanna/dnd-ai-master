import { describe, it, expect } from 'vitest';
import { castSpell } from '@/engine/spells';
import { makeSeededRng } from '@/engine/rand';
import type { Character, ActorRuntimeState } from '@/engine/types';

function wizard(level = 1, spells: string[] = []): Character {
  return {
    id: 'pc1', name: 'Lyra', level, xp: 0,
    classSlug: 'wizard', raceSlug: 'high-elf', backgroundSlug: 'sage',
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
    proficiencyBonus: Math.ceil(level / 4) + 1, hpMax: 28, ac: 12, speed: 30,
    proficiencies: { saves: ['INT', 'WIS'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: { ability: 'INT', spellSaveDC: 15, spellAttackBonus: 7, slotsMax: { 1: 4, 2: 3, 3: 2 }, spellsKnown: spells, spellsPrepared: [] },
    features: [], inventory: [], hitDiceMax: level, hitDieSize: 6,
  };
}
function rt(c: Character): ActorRuntimeState {
  return { actorId: c.id, hpCurrent: c.hpMax, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], spellSlotsUsed: {}, resourcesUsed: {} };
}

describe('Bug #1: slot-level bypass', () => {
  it('cure-wounds at slotLevel=0 → error slot_too_low', () => {
    const c = wizard(5, ['cure-wounds']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'cure-wounds', slotLevel: 0, targets: [{ id: 'pc1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('slot_too_low');
  });
  it('fireball at slotLevel=0 → error slot_too_low', () => {
    const c = wizard(5, ['fireball']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'fireball', slotLevel: 0, targets: [{ id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('slot_too_low');
  });
  it('fireball at slotLevel=2 (below min 3) → error slot_too_low', () => {
    const c = wizard(5, ['fireball']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'fireball', slotLevel: 2, targets: [{ id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('slot_too_low');
  });
  it('cure-wounds at slotLevel=1 (= min) succeeds', () => {
    const c = wizard(5, ['cure-wounds']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'cure-wounds', slotLevel: 1, targets: [{ id: 'pc1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
  });
  it('fire-bolt at slotLevel=0 (cantrip, min=0) succeeds', () => {
    const c = wizard(5, ['fire-bolt']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'fire-bolt', slotLevel: 0, targets: [{ id: 'm1', ac: 10 }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
  });
  it('unbound spell at slotLevel=0 still works (legacy narrative)', () => {
    const c = wizard(5, ['some-homebrew']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'some-homebrew', slotLevel: 0, targets: [] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
  });
});

describe('Bug #2: attack_damage requires target.ac', () => {
  it('fire-bolt without target.ac → error', () => {
    const c = wizard(5, ['fire-bolt']);
    const r = castSpell({ caster: c, runtime: rt(c), spellSlug: 'fire-bolt', slotLevel: 0, targets: [{ id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ac/i);
  });
});

describe('Bug #3: appliedRound from currentRound', () => {
  it('hold-person passes currentRound to add_condition', () => {
    const c = wizard(5, ['hold-person']);
    const runtime = { ...rt(c), spellSlotsUsed: { 2: 0 } };
    const r = castSpell({ caster: c, runtime, spellSlug: 'hold-person', slotLevel: 2, targets: [{ id: 'm1' }], currentRound: 5 }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    const addCond = r.mutations.find((m) => m.op === 'add_condition');
    expect(addCond).toBeDefined();
    if (addCond?.op === 'add_condition') {
      expect(addCond.condition.appliedRound).toBe(5);
    }
  });
  it('bless (buff) passes currentRound', () => {
    const c = wizard(5, ['bless']);
    const runtime = { ...rt(c), spellSlotsUsed: { 1: 0 } };
    const r = castSpell({ caster: c, runtime, spellSlug: 'bless', slotLevel: 1, targets: [{ id: 'pc1' }], currentRound: 7 }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    const addCond = r.mutations.find((m) => m.op === 'add_condition');
    if (addCond?.op === 'add_condition') {
      expect(addCond.condition.appliedRound).toBe(7);
    }
  });
});

describe('Bug #4: cantrip scaling + crit upcast doubling', () => {
  it('fire-bolt at level 5 deals 2d10 (cantrip scaling)', () => {
    const c = wizard(5, ['fire-bolt']);
    // Use rng forcing nat 20 to bypass AC issue; verify damage matches 2d10
    // We can use makeSeededRng to get deterministic d10 rolls; assert sum is in [2..20] for 2d10 vs [1..10] for 1d10
    // Use a controlled rng: roll high d20, then small d10s
    const r = castSpell({
      caster: c, runtime: rt(c), spellSlug: 'fire-bolt', slotLevel: 0,
      targets: [{ id: 'm1', ac: 5 }],  // low AC to ensure hit
    }, () => 0.5);  // d20 = 11; +7 = 18 ≥ 5 → hit; subsequent rolls are damage
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2d10 means: rolls.length includes 2 dice in the damage formula
      // The exact total varies but the formula should reflect 2d10
      const dmgRoll = r.rolls[1]; // first is attack, second is damage
      expect(dmgRoll?.formula).toMatch(/2d10/);
    }
  });
  it('fire-bolt at level 1 deals 1d10', () => {
    const c = wizard(1, ['fire-bolt']);
    const r = castSpell({
      caster: c, runtime: rt(c), spellSlug: 'fire-bolt', slotLevel: 0,
      targets: [{ id: 'm1', ac: 5 }],
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const dmgRoll = r.rolls[1];
    expect(dmgRoll?.formula).toMatch(/1d10/);
  });
  it('fire-bolt at level 11 deals 3d10', () => {
    const c = wizard(11, ['fire-bolt']);
    const r = castSpell({
      caster: c, runtime: rt(c), spellSlug: 'fire-bolt', slotLevel: 0,
      targets: [{ id: 'm1', ac: 5 }],
    }, () => 0.5);
    expect(r.ok).toBe(true);
    const dmgRoll = r.rolls[1];
    expect(dmgRoll?.formula).toMatch(/3d10/);
  });
});
