import { describe, it, expect } from 'vitest';
import { applyDamage } from '@/engine/combat/damage';
import type { ActorRuntimeState, CombatActor, Character } from '@/engine/types';

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: ['fire'], conditionImmunities: [],
};

const goblinRuntime: ActorRuntimeState = {
  actorId: 'm1', hpCurrent: 7, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 },
};

describe('applyDamage', () => {
  it('reduces hpCurrent by amount', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 4, type: 'slashing' });
    expect(r.data?.newHp).toBe(3);
    expect(r.mutations[0]).toEqual({ op: 'set_hp', actorId: 'm1', hpCurrent: 3 });
  });

  it('applies vulnerability (doubles)', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 3, type: 'fire' });
    expect(r.data?.newHp).toBe(7 - 6);
  });

  it('temp HP absorbs damage first', () => {
    const withTemp: ActorRuntimeState = { ...goblinRuntime, tempHp: 3 };
    const r = applyDamage({ runtime: withTemp, target: goblin, amount: 5, type: 'slashing' });
    expect(r.data?.newTempHp).toBe(0);
    expect(r.data?.newHp).toBe(7 - 2);                            // 5 - 3 temp = 2 to hp
    expect(r.mutations.some((m) => m.op === 'set_temp_hp')).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp')).toBe(true);
  });

  it('clamps hp at 0 (no negative HP for monsters)', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 100, type: 'fire' });
    expect(r.data?.newHp).toBe(0);
  });

  it('PCs at 0 HP enter death save state, not dead', () => {
    const fighter: Character = {
      id: 'pc1', name: 'Tharion', level: 1, xp: 0,
      classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    };
    const fighterRuntime: ActorRuntimeState = { actorId: 'pc1', hpCurrent: 4, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } };
    const r = applyDamage({ runtime: fighterRuntime, target: fighter as unknown as CombatActor, amount: 10, type: 'slashing' });
    expect(r.data?.newHp).toBe(0);
    expect(r.data?.dying).toBe(true);
  });

  it('massive damage: PC drops to 0 with leftover ≥ hpMax → instant death', () => {
    const fighter: Character = {
      id: 'pc1', name: 'Tharion', level: 1, xp: 0,
      classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    };
    const fighterRuntime: ActorRuntimeState = { actorId: 'pc1', hpCurrent: 5, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } };
    const r = applyDamage({ runtime: fighterRuntime, target: fighter as unknown as CombatActor, amount: 30, type: 'slashing' });
    expect(r.data?.dead).toBe(true);
  });
});
