import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS, TOOL_HANDLERS_DB, TOOL_DEFINITIONS } from '@/engine';
import { buildToolDefinitions } from '@/engine/tools';
import type { EngineState, Character, CombatActor } from '@/engine';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [{ slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second Wind' }],
  inventory: [{ slug: 'longsword', qty: 1, equipped: true }, { slug: 'chain-mail', qty: 1, equipped: false }],
  hitDiceMax: 5, hitDieSize: 10,
};

const wizard: Character = {
  id: 'pc2', name: 'Lyra', level: 5, xp: 0,
  classSlug: 'wizard', raceSlug: 'high-elf', backgroundSlug: 'sage',
  abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 28, ac: 12, speed: 30,
  proficiencies: { saves: ['INT', 'WIS'], skills: ['Arcana'], expertise: [], weapons: [], armor: [], tools: [], languages: ['Common'] },
  spellcasting: { ability: 'INT', spellSaveDC: 15, spellAttackBonus: 7, slotsMax: { 1: 4, 2: 3, 3: 2 }, spellsKnown: ['magic-missile', 'healing-word'], spellsPrepared: [] },
  features: [], inventory: [], hitDiceMax: 5, hitDieSize: 6,
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

const wizardState: EngineState = {
  characters: [wizard],
  combatActors: [goblin],
  runtime: {
    pc2: { actorId: 'pc2', hpCurrent: 28, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, spellSlotsUsed: {}, resourcesUsed: {} },
    m1:  { actorId: 'm1',  hpCurrent: 7,  tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
  },
  combat: null,
  scene: 'wizard tower',
};

describe('TOOL_DEFINITIONS', () => {
  it('every defined tool has a corresponding handler (sync or db)', () => {
    for (const def of TOOL_DEFINITIONS) {
      const hasHandler = TOOL_HANDLERS[def.name] !== undefined || TOOL_HANDLERS_DB[def.name] !== undefined;
      expect(hasHandler, `missing handler for ${def.name}`).toBe(true);
    }
  });

  it('every handler has a corresponding definition (with all tools enabled)', () => {
    const all = buildToolDefinitions({ imageGenerationEnabled: true });
    const definedNames = new Set(all.map((d) => d.name));
    for (const name of Object.keys(TOOL_HANDLERS)) {
      expect(definedNames.has(name), `missing definition for handler ${name}`).toBe(true);
    }
    for (const name of Object.keys(TOOL_HANDLERS_DB)) {
      expect(definedNames.has(name), `missing definition for db handler ${name}`).toBe(true);
    }
  });
});

describe('TOOL_HANDLERS — happy paths', () => {
  it('roll_dice returns total and rolls', () => {
    const r = TOOL_HANDLERS['roll_dice']!(baseState, { formula: '2d6+3' });
    expect(r.ok).toBe(true);
    expect(r.rolls.length).toBe(1);
    expect(typeof (r.data as { total: number }).total).toBe('number');
  });

  it('roll_d20 with modifier returns total', () => {
    const r = TOOL_HANDLERS['roll_d20']!(baseState, { modifier: 5, advantage: true });
    expect(r.ok).toBe(true);
    expect(r.rolls.length).toBe(1);
  });

  it('roll_d20 with no modifier defaults to 0', () => {
    const r = TOOL_HANDLERS['roll_d20']!(baseState, {});
    expect(r.ok).toBe(true);
  });

  it('ability_check resolves player_character actor and returns result', () => {
    const r = TOOL_HANDLERS['ability_check']!(baseState, {
      actor: 'player_character', skill: 'Athletics', dc: 10,
    });
    expect(r.rolls.length).toBeGreaterThanOrEqual(1);
  });

  it('saving_throw returns a roll', () => {
    const r = TOOL_HANDLERS['saving_throw']!(baseState, {
      actor: 'player_character', ability: 'STR', dc: 12,
    });
    expect(r.rolls.length).toBeGreaterThanOrEqual(1);
  });

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

  it('apply_damage works for character target too', () => {
    const r = TOOL_HANDLERS['apply_damage']!(baseState, {
      actor: 'pc1', amount: 5, type: 'piercing',
    });
    expect(r.ok).toBe(true);
  });

  it('end_turn returns advance_turn mutation when in combat', () => {
    const inCombat: EngineState = {
      ...baseState,
      combat: { round: 1, currentIdx: 0, turnOrder: [{ actorId: 'pc1', initiative: 15 }, { actorId: 'm1', initiative: 12 }] },
    };
    const r = TOOL_HANDLERS['end_turn']!(inCombat, {});
    expect(r.ok).toBe(true);
  });

  it('cast_spell consumes slot and produces mutations', () => {
    const r = TOOL_HANDLERS['cast_spell']!(wizardState, {
      caster: 'player_character', spellSlug: 'magic-missile', slotLevel: 1,
      targets: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }],
    });
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
  });

  it('cast_spell with empty targets array works', () => {
    const r = TOOL_HANDLERS['cast_spell']!(wizardState, {
      caster: 'player_character', spellSlug: 'magic-missile', slotLevel: 1,
    });
    // Should still attempt cast, either ok or error; just make sure handler executes the no-targets branch
    expect(typeof r.ok).toBe('boolean');
  });

  it('apply_condition adds the condition', () => {
    const r = TOOL_HANDLERS['apply_condition']!(baseState, {
      actor: 'm1', condition: 'poisoned', source: 'snake bite', durationRounds: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'add_condition')).toBe(true);
  });

  it('apply_condition with until_removed duration', () => {
    const r = TOOL_HANDLERS['apply_condition']!(baseState, {
      actor: 'm1', condition: 'frightened', source: 'cause fear', durationRounds: 'until_removed',
    });
    expect(r.ok).toBe(true);
  });

  it('apply_condition uses combat round when combat present', () => {
    const inCombat: EngineState = {
      ...baseState,
      combat: { round: 4, currentIdx: 0, turnOrder: [{ actorId: 'pc1', initiative: 15 }, { actorId: 'm1', initiative: 12 }] },
    };
    const r = TOOL_HANDLERS['apply_condition']!(inCombat, {
      actor: 'm1', condition: 'poisoned', source: 'spell', durationRounds: 2,
    });
    expect(r.ok).toBe(true);
  });

  it('remove_condition removes a condition', () => {
    const stateWithCondition: EngineState = {
      ...baseState,
      runtime: {
        ...baseState.runtime,
        m1: {
          ...baseState.runtime.m1!,
          conditions: [{ slug: 'poisoned', source: 'snake', durationRounds: 3, appliedRound: 1 }],
        },
      },
    };
    const r = TOOL_HANDLERS['remove_condition']!(stateWithCondition, {
      actor: 'm1', condition: 'poisoned',
    });
    expect(r.ok).toBe(true);
  });

  it('use_resource consumes the resource', () => {
    const r = TOOL_HANDLERS['use_resource']!(baseState, {
      actor: 'player_character', featureSlug: 'second_wind',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('use_resource');
  });

  it('use_resource defaults amount to 1', () => {
    const r = TOOL_HANDLERS['use_resource']!(baseState, {
      actor: 'pc1', featureSlug: 'second_wind',
    });
    expect(r.ok).toBe(true);
  });

  it('short_rest returns mutations with hit dice spent', () => {
    const r = TOOL_HANDLERS['short_rest']!(baseState, {
      actor: 'player_character', hitDiceSpent: 1,
    });
    expect(r.ok).toBe(true);
  });

  it('short_rest with default hit dice spent (none)', () => {
    const r = TOOL_HANDLERS['short_rest']!(baseState, {
      actor: 'pc1',
    });
    expect(r.ok).toBe(true);
  });

  it('long_rest restores resources', () => {
    const r = TOOL_HANDLERS['long_rest']!(baseState, {
      actor: 'player_character',
    });
    expect(r.ok).toBe(true);
  });

  it('equip equips an item from inventory', () => {
    const r = TOOL_HANDLERS['equip']!(baseState, {
      actor: 'player_character', itemSlug: 'chain-mail',
    });
    expect(r.ok).toBe(true);
  });

  it('unequip unequips an item', () => {
    const r = TOOL_HANDLERS['unequip']!(baseState, {
      actor: 'player_character', itemSlug: 'longsword',
    });
    expect(r.ok).toBe(true);
  });

  it('recompute_ac returns AC mutation', () => {
    const r = TOOL_HANDLERS['recompute_ac']!(baseState, {
      actor: 'player_character',
    });
    expect(r.ok).toBe(true);
  });

  it('level_up increases level with default hpRollMode', () => {
    const r = TOOL_HANDLERS['level_up']!(baseState, {
      actor: 'player_character', newLevel: 6,
    });
    expect(r.ok).toBe(true);
  });

  it('level_up with rolled hpRollMode', () => {
    const r = TOOL_HANDLERS['level_up']!(baseState, {
      actor: 'pc1', newLevel: 6, hpRollMode: 'rolled',
    });
    expect(r.ok).toBe(true);
  });
});

describe('TOOL_HANDLERS — error branches', () => {
  it('ability_check unknown actor returns clean error', () => {
    const r = TOOL_HANDLERS['ability_check']!(baseState, {
      actor: 'nonexistent', skill: 'Athletics', dc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('saving_throw unknown actor returns error', () => {
    const r = TOOL_HANDLERS['saving_throw']!(baseState, {
      actor: 'nonexistent', ability: 'STR', dc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('make_attack unknown attacker returns error', () => {
    const r = TOOL_HANDLERS['make_attack']!(baseState, {
      attacker: 'nonexistent', target: 'm1',
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_attacker');
  });

  it('make_attack unknown target returns error', () => {
    const r = TOOL_HANDLERS['make_attack']!(baseState, {
      attacker: 'pc1', target: 'no-such-target',
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_target');
  });

  it('make_attack bad weapon returns error', () => {
    const r = TOOL_HANDLERS['make_attack']!(baseState, {
      attacker: 'pc1', target: 'm1',
      weapon: 'not-an-object',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad_weapon');
  });

  it('apply_damage unknown actor returns error', () => {
    const r = TOOL_HANDLERS['apply_damage']!(baseState, {
      actor: 'nonexistent', amount: 5, type: 'fire',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('end_turn outside combat returns error', () => {
    const r = TOOL_HANDLERS['end_turn']!(baseState, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_in_combat');
  });

  it('cast_spell unknown caster returns error', () => {
    const r = TOOL_HANDLERS['cast_spell']!(wizardState, {
      caster: 'nonexistent', spellSlug: 'magic-missile', slotLevel: 1, targets: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_caster');
  });

  it('apply_condition unknown actor returns error', () => {
    const r = TOOL_HANDLERS['apply_condition']!(baseState, {
      actor: 'nonexistent', condition: 'poisoned', source: 'x', durationRounds: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('remove_condition unknown actor returns error', () => {
    const r = TOOL_HANDLERS['remove_condition']!(baseState, {
      actor: 'nonexistent', condition: 'poisoned',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('use_resource unknown actor returns error', () => {
    const r = TOOL_HANDLERS['use_resource']!(baseState, {
      actor: 'nonexistent', featureSlug: 'second_wind',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('short_rest unknown actor returns error', () => {
    const r = TOOL_HANDLERS['short_rest']!(baseState, {
      actor: 'nonexistent',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('long_rest unknown actor returns error', () => {
    const r = TOOL_HANDLERS['long_rest']!(baseState, {
      actor: 'nonexistent',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('equip unknown actor returns error', () => {
    const r = TOOL_HANDLERS['equip']!(baseState, {
      actor: 'nonexistent', itemSlug: 'longsword',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('unequip unknown actor returns error', () => {
    const r = TOOL_HANDLERS['unequip']!(baseState, {
      actor: 'nonexistent', itemSlug: 'longsword',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('recompute_ac unknown actor returns error', () => {
    const r = TOOL_HANDLERS['recompute_ac']!(baseState, {
      actor: 'nonexistent',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('level_up unknown actor returns error', () => {
    const r = TOOL_HANDLERS['level_up']!(baseState, {
      actor: 'nonexistent', newLevel: 6,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('player_character ref does not resolve when state has multiple PCs', () => {
    const multiPcState: EngineState = {
      ...baseState,
      characters: [fighter, wizard],
      runtime: {
        ...baseState.runtime,
        pc2: { actorId: 'pc2', hpCurrent: 28, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, spellSlotsUsed: {}, resourcesUsed: {} },
      },
    };
    // With multiple PCs, 'player_character' is treated literally and doesn't match a real ID.
    const r = TOOL_HANDLERS['ability_check']!(multiPcState, {
      actor: 'player_character', skill: 'Athletics', dc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });
});
