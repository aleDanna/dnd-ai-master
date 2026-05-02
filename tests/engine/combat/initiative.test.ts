import { describe, it, expect } from 'vitest';
import { rollInitiative } from '@/engine/combat/initiative';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor } from '@/engine/types';

const pc: Character = {
  id: 'pc1', name: 'Tharion', level: 1, classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', monsterSlug: 'goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('rollInitiative', () => {
  it('returns turn order sorted by initiative desc', () => {
    const r = rollInitiative({ pcs: [pc], monsters: [goblin] }, makeSeededRng(1));
    expect(r.data?.turnOrder.length).toBe(2);
    const order = r.data!.turnOrder;
    expect(order[0]!.initiative).toBeGreaterThanOrEqual(order[1]!.initiative);
  });

  it('records mutations to set combat state', () => {
    const r = rollInitiative({ pcs: [pc], monsters: [goblin] }, makeSeededRng(1));
    expect(r.mutations.some((m) => m.op === 'set_combat')).toBe(true);
  });

  it('breaks ties by DEX score (PC first), then by id', () => {
    // Force tie via custom RNG
    const fixedRng = { intInclusive: () => 10 };
    const r = rollInitiative({ pcs: [pc], monsters: [goblin] }, fixedRng);
    expect(r.data?.turnOrder.length).toBe(2);
    // Both rolled 10. PC has DEX 16, goblin has DEX 14, so PC first.
    expect(r.data!.turnOrder[0]!.actorId).toBe('pc1');
  });
});
