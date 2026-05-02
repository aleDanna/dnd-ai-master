import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from '@/engine';
import type { EngineState, Character, CombatActor } from '@/engine';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [{ slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second Wind' }],
  inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

const baseState: EngineState = {
  characters: [fighter],
  combatActors: [goblin],
  runtime: {
    pc1: { actorId: 'pc1', hpCurrent: 44, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, spellSlotsUsed: {}, resourcesUsed: {} },
    m1:  { actorId: 'm1',  hpCurrent: 7,  tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
  },
  combat: null,
  scene: 'goblin warren',
};

describe('TOOL_DEFINITIONS', () => {
  it('every defined tool has a corresponding handler', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(TOOL_HANDLERS[def.name], `missing handler for ${def.name}`).toBeDefined();
    }
  });

  it('every handler has a corresponding definition', () => {
    const definedNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
    for (const name of Object.keys(TOOL_HANDLERS)) {
      expect(definedNames.has(name), `missing definition for handler ${name}`).toBe(true);
    }
  });
});

describe('TOOL_HANDLERS', () => {
  it('roll_initiative emits set_combat mutation', () => {
    const r = TOOL_HANDLERS['roll_initiative']!(baseState, {});
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_combat')).toBe(true);
  });

  it('make_attack against goblin returns hit-or-miss with rolls', () => {
    const r = TOOL_HANDLERS['make_attack']!(baseState, {
      attacker: 'player_character',
      target: 'm1',
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    });
    expect(['miss', undefined]).toContain(r.error);
    expect(r.rolls.length).toBeGreaterThanOrEqual(1);
  });

  it('apply_damage reduces target HP', () => {
    const r = TOOL_HANDLERS['apply_damage']!(baseState, {
      actor: 'm1', amount: 3, type: 'slashing',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp')).toBe(true);
  });

  it('use_resource consumes the resource', () => {
    const r = TOOL_HANDLERS['use_resource']!(baseState, {
      actor: 'player_character', featureSlug: 'second_wind',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('use_resource');
  });

  it('unknown actor returns clean error, not crash', () => {
    const r = TOOL_HANDLERS['ability_check']!(baseState, {
      actor: 'nonexistent', skill: 'Athletics', dc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });
});
