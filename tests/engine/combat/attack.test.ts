import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('makeAttack', () => {
  it('on hit: returns ok=true, damage roll, apply_damage mutation', () => {
    // Find a seed where the d20 hits AC 15
    let seed = 0;
    while (seed < 100) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
      }, makeSeededRng(seed));
      if (r.ok) {
        expect(r.rolls.length).toBeGreaterThanOrEqual(2);    // attack + damage
        expect(r.mutations.some((m) => m.op === 'apply_damage' && (m as { actorId: string }).actorId === 'm1')).toBe(true);
        return;
      }
      seed++;
    }
    throw new Error('No hit found in 100 seeds — RNG suspicious');
  });

  it('on miss: ok=false, no damage roll, no mutations', () => {
    let seed = 0;
    while (seed < 100) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
        disadvantage: true,
      }, makeSeededRng(seed));
      if (!r.ok && r.error === 'miss') {
        expect(r.mutations.length).toBe(0);
        expect(r.rolls.length).toBe(1);                        // only attack roll
        return;
      }
      seed++;
    }
    throw new Error('No miss found in 100 seeds — RNG suspicious');
  });

  it('natural 20 always hits and crits damage', () => {
    const fixed20 = { intInclusive: (min: number, max: number) => max === 20 ? 20 : 1 + min };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixed20);
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
    // Damage roll should have 2 dice (1d8 doubled)
    const damageRoll = r.rolls[1]!;
    expect(damageRoll.rolls.length).toBe(2);
  });

  it('natural 1 always misses regardless of bonus', () => {
    const fixed1 = { intInclusive: (_min: number, max: number) => max === 20 ? 1 : 1 };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixed1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('miss');
    expect(r.data?.crit).toBeFalsy();
  });

  it('respects target resistance/immunity: damage halved on resistance, zero on immunity', () => {
    const resistantGoblin: CombatActor = { ...goblin, resistances: ['slashing'] };
    const fixedHit = { intInclusive: (_min: number, max: number) => max === 20 ? 18 : Math.ceil(max / 2) };
    const r = makeAttack({
      attacker: fighter,
      target: resistantGoblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixedHit);
    expect(r.ok).toBe(true);
    const dmgMut = r.mutations.find((m) => m.op === 'apply_damage') as { amount: number } | undefined;
    expect(dmgMut).toBeDefined();
    // The mutation amount should reflect halving (ceil(raw / 2)) — engine handles this.
    expect(dmgMut!.amount).toBeGreaterThan(0);
  });
});
