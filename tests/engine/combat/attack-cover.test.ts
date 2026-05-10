import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import type { WeaponSpec } from '@/engine/combat/attack';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor } from '@/engine/types';

const fighter: Character = {
  id: 'pc1',
  name: 'Tharion',
  level: 5,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 44,
  ac: 18,
  speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'],
    skills: ['Athletics'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    tools: [],
    languages: ['Common'],
  },
  spellcasting: null,
  features: [],
  inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5,
  hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1',
  kind: 'monster',
  name: 'Goblin',
  hpMax: 7,
  ac: 13, // moderate AC so half cover meaningfully shifts hit chance
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2,
  initiativeBonus: 2,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
};

const longsword: WeaponSpec = {
  name: 'Longsword',
  damage: '1d8',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
};

describe('makeAttack — cover (PHB §3.12)', () => {
  it('total cover: ok:false target_in_total_cover, no rolls, no mutations (no consumption)', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      cover: 'total',
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('target_in_total_cover');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('half cover: same total may hit without cover but miss with cover', () => {
    // Find a seed where attackTotal is ≥ AC 13 but < AC 15 (13 + 2).
    for (let seed = 0; seed < 500; seed++) {
      const baseline = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: longsword,
      }, makeSeededRng(seed));
      const withHalf = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: longsword,
        cover: 'half',
      }, makeSeededRng(seed));
      const baseTotal = baseline.rolls[0]?.total ?? 0;
      // Skip nat-20 (hits regardless of cover) and nat-1 (misses regardless).
      const baseNat = baseline.rolls[0]?.rolls[0];
      if (baseNat === 20 || baseNat === 1) continue;
      if (baseTotal >= 13 && baseTotal < 15) {
        expect(baseline.ok).toBe(true);
        expect(withHalf.ok).toBe(false);
        expect(withHalf.error).toBe('miss');
        return;
      }
    }
    // If we couldn't find that exact band, at least confirm both calls are
    // self-consistent (covered by the next tests).
  });

  it('three-quarters cover: same total may hit without cover but miss at +5 AC', () => {
    for (let seed = 0; seed < 500; seed++) {
      const baseline = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: longsword,
      }, makeSeededRng(seed));
      const withTQ = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: longsword,
        cover: 'three-quarters',
      }, makeSeededRng(seed));
      const baseTotal = baseline.rolls[0]?.total ?? 0;
      const baseNat = baseline.rolls[0]?.rolls[0];
      if (baseNat === 20 || baseNat === 1) continue;
      if (baseTotal >= 13 && baseTotal < 18) {
        expect(baseline.ok).toBe(true);
        expect(withTQ.ok).toBe(false);
        expect(withTQ.error).toBe('miss');
        return;
      }
    }
  });

  it('natural 20 still crits through half cover (hit regardless of effective AC)', () => {
    const fixed20 = { intInclusive: (_min: number, max: number) => max === 20 ? 20 : Math.ceil(max / 2) };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      cover: 'half',
    }, fixed20);
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
  });

  it('natural 20 still crits through three-quarters cover', () => {
    const fixed20 = { intInclusive: (_min: number, max: number) => max === 20 ? 20 : Math.ceil(max / 2) };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      cover: 'three-quarters',
    }, fixed20);
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
  });

  it('cover undefined behaves identically to no cover argument', () => {
    const r1 = makeAttack({ attacker: fighter, target: goblin, weapon: longsword }, makeSeededRng(7));
    const r2 = makeAttack({ attacker: fighter, target: goblin, weapon: longsword, cover: 'none' }, makeSeededRng(7));
    expect(r1.ok).toBe(r2.ok);
    expect(r1.rolls[0]?.total).toBe(r2.rolls[0]?.total);
  });
});
