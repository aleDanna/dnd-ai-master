import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { applyDamage } from '@/engine/combat/damage';
import { newTurnState } from '@/engine/combat/turn-state';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  ConditionInstance,
  TurnState,
} from '@/engine/types';

const fixed20 = { intInclusive: (min: number, max: number) => max === 20 ? 20 : 1 + min };

function rng(values: number[]) {
  let i = 0;
  return {
    intInclusive(min: number, max: number) {
      if (i >= values.length) {
        // Default to ones for any extra rolls.
        return min;
      }
      const v = values[i]!;
      i += 1;
      if (v < min) return min;
      if (v > max) return max;
      return v;
    },
  };
}

const conds = (...slugs: ConditionInstance['slug'][]): ConditionInstance[] =>
  slugs.map((slug) => ({ slug, source: 'test', durationRounds: 'until_removed', appliedRound: 0 }));

function rt(opts: {
  actorId: string;
  conditions?: ConditionInstance[];
  turnState?: Partial<TurnState>;
  hpCurrent?: number;
}): ActorRuntimeState {
  return {
    actorId: opts.actorId,
    hpCurrent: opts.hpCurrent ?? 30,
    tempHp: 0,
    conditions: opts.conditions ?? [],
    deathSaves: { successes: 0, failures: 0 },
    ...(opts.turnState ? { turnState: { ...newTurnState(), ...opts.turnState } } : {}),
  };
}

const rogueL5: Character = {
  id: 'pc1', name: 'Sly', level: 5, xp: 0,
  classSlug: 'rogue',
  classes: [{ slug: 'rogue', level: 5 }],
  raceSlug: 'human', backgroundSlug: 'criminal',
  abilities: { STR: 10, DEX: 18, CON: 12, INT: 12, WIS: 10, CHA: 14 },
  proficiencyBonus: 3, hpMax: 30, ac: 14, speed: 30,
  proficiencies: { saves: ['DEX', 'INT'], skills: ['Stealth'], expertise: [], weapons: ['Simple', 'longsword', 'rapier', 'shortsword', 'shortbow'], armor: ['Light'], tools: [], languages: [] },
  spellcasting: null,
  features: [{ slug: 'sneak_attack', source: 'class', usesMax: 'unlimited', description: 'Sneak Attack' }],
  inventory: [],
  hitDiceMax: 5, hitDieSize: 8,
};

const barbL5: Character = {
  id: 'pc2', name: 'Krug', level: 5, xp: 0,
  classSlug: 'barbarian',
  classes: [{ slug: 'barbarian', level: 5 }],
  raceSlug: 'half-orc', backgroundSlug: 'outlander',
  abilities: { STR: 18, DEX: 14, CON: 16, INT: 8, WIS: 12, CHA: 8 },
  proficiencyBonus: 3, hpMax: 50, ac: 14, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Shield'], tools: [], languages: [] },
  spellcasting: null,
  features: [{ slug: 'rage', source: 'class', usesMax: 3, description: 'Rage' }],
  inventory: [],
  hitDiceMax: 5, hitDieSize: 12,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 50, ac: 10, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('Sneak Attack', () => {
  it('rejects non-finesse, non-ranged weapon', () => {
    const r = makeAttack(
      {
        attacker: rogueL5,
        target: goblin,
        // Greatsword: heavy melee, no finesse.
        weapon: { name: 'Greatsword', damage: '2d6', damageType: 'slashing', profGroup: 'Martial', useDex: false, properties: ['heavy', 'two-handed'] },
        useSneakAttack: true,
        advantage: true,
      },
      fixed20,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sneak_attack_invalid_weapon');
  });

  it('rejects when sneakAttackUsed already on turnState', () => {
    const r = makeAttack(
      {
        attacker: rogueL5,
        target: goblin,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        useSneakAttack: true,
        advantage: true,
        attackerRuntime: rt({ actorId: 'pc1', turnState: { sneakAttackUsed: true } }),
      },
      fixed20,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sneak_attack_already_used');
  });

  it('on hit with ADV: rolls extra ceil(level/2)d6 damage and emits mark_sneak_attack', () => {
    // L5 → 3d6 sneak attack. We force the rng to make the d20 hit and damage rolls predictable.
    // Sequence: d20=20, d20=15 (advantage), then 1d8 weapon roll, then 3d6 sneak attack.
    const r = makeAttack(
      {
        attacker: rogueL5,
        target: goblin,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        useSneakAttack: true,
        advantage: true,
      },
      rng([20, 15, 6, 4, 5, 3]), // d20a=20, d20b=15, dmg=6, sa=[4,5,3]=12
    );
    expect(r.ok).toBe(true);
    // Crit happened (natural 20) — sneak attack dice doubled (3 -> 6 dice).
    expect(r.data?.crit).toBe(true);
    expect(r.data?.sneakAttackDamage).toBeGreaterThan(0);
    expect(r.mutations.some((m) => m.op === 'mark_sneak_attack')).toBe(true);
  });

  it('on hit without ADV but with allyAdjacent: applies sneak attack', () => {
    const r = makeAttack(
      {
        attacker: rogueL5,
        target: goblin,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        useSneakAttack: true,
        allyAdjacent: true,
      },
      // d20 = 18 (hit with bonus +7 vs AC 10), dmg=6, sa=[4,5,3]=12
      rng([18, 6, 4, 5, 3]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.sneakAttackDamage).toBe(12);
    expect(r.mutations.some((m) => m.op === 'mark_sneak_attack')).toBe(true);
  });

  it('on hit without ADV and no allyAdjacent: NO sneak attack damage even if useSneakAttack=true', () => {
    const r = makeAttack(
      {
        attacker: rogueL5,
        target: goblin,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        useSneakAttack: true,
      },
      rng([18, 6]), // no SA dice should be rolled
    );
    expect(r.ok).toBe(true);
    expect(r.data?.sneakAttackDamage).toBeUndefined();
    expect(r.mutations.some((m) => m.op === 'mark_sneak_attack')).toBe(false);
  });

  it('ranged finesse-like weapon (shortbow) works without finesse property when ranged=true', () => {
    const rogueWithArrows: Character = { ...rogueL5, inventory: [{ slug: 'arrow', qty: 10, equipped: false }] };
    const r = makeAttack(
      {
        attacker: rogueWithArrows,
        target: goblin,
        weapon: { name: 'Shortbow', damage: '1d6', damageType: 'piercing', profGroup: 'Simple', useDex: true, properties: ['ammunition'], ammoSlug: 'arrow' },
        useSneakAttack: true,
        advantage: true,
        ranged: true,
      },
      rng([18, 1, 4, 4, 4, 4]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.sneakAttackDamage).toBeGreaterThan(0);
  });
});

describe('Rage damage bonus', () => {
  it('barbarian L5 raging adds +2 to melee STR weapon damage', () => {
    const attackerRuntime = rt({ actorId: 'pc2', conditions: conds('raging') });
    const r = makeAttack(
      {
        attacker: barbL5,
        target: goblin,
        weapon: { name: 'Greataxe', damage: '1d12', damageType: 'slashing', profGroup: 'Martial', useDex: false, properties: ['heavy', 'two-handed'] },
        attackerRuntime,
      },
      // d20=18 (hit), 1d12=8
      rng([18, 8]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.rageBonus).toBe(2);
    // Base damage = 8 + STR 4 = 12. With rage = 14.
    // Goblin has no resistance — finalDamage = 14.
    expect(r.data?.rawDamage).toBe(14);
    expect(r.data?.finalDamage).toBe(14);
  });

  it('rage bonus does NOT apply to ranged attacks', () => {
    const attackerRuntime = rt({ actorId: 'pc2', conditions: conds('raging') });
    const barbWithBow = { ...barbL5, inventory: [{ slug: 'arrow', qty: 5, equipped: false }] };
    const r = makeAttack(
      {
        attacker: barbWithBow,
        target: goblin,
        weapon: { name: 'Shortbow', damage: '1d6', damageType: 'piercing', profGroup: 'Simple', useDex: true, properties: ['ammunition'], ammoSlug: 'arrow' },
        ranged: true,
        attackerRuntime,
      },
      rng([18, 4]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.rageBonus).toBeUndefined();
  });

  it('rage bonus does NOT apply to DEX-based melee (finesse used as DEX)', () => {
    const attackerRuntime = rt({ actorId: 'pc2', conditions: conds('raging') });
    const r = makeAttack(
      {
        attacker: barbL5,
        target: goblin,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        attackerRuntime,
      },
      rng([18, 4]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.rageBonus).toBeUndefined();
  });

  it('non-barbarian classed actor with raging condition gets 0 bonus', () => {
    // Edge: a fighter with the raging condition (somehow). Bonus should be 0.
    const fighter: Character = { ...barbL5, id: 'pc3', classSlug: 'fighter', classes: [{ slug: 'fighter', level: 5 }] };
    const attackerRuntime = rt({ actorId: 'pc3', conditions: conds('raging') });
    const r = makeAttack(
      {
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Greataxe', damage: '1d12', damageType: 'slashing', profGroup: 'Martial', useDex: false, properties: ['heavy', 'two-handed'] },
        attackerRuntime,
      },
      rng([18, 6]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.rageBonus).toBeUndefined();
  });
});

describe('Rage resistance (target raging)', () => {
  it('halves bludgeoning damage against a raging target', () => {
    const ragingGoblin: CombatActor = { ...goblin };
    const targetRuntime = rt({ actorId: 'm1', conditions: conds('raging') });
    const r = makeAttack(
      {
        attacker: barbL5, // attacker is unrelated; we just need a melee attack
        target: ragingGoblin,
        weapon: { name: 'Greataxe', damage: '1d12', damageType: 'slashing', profGroup: 'Martial', useDex: false, properties: ['heavy', 'two-handed'] },
        targetRuntime,
      },
      rng([18, 8]),
    );
    expect(r.ok).toBe(true);
    // raw = 8 + STR 4 = 12; halved = 6.
    expect(r.data?.rawDamage).toBe(12);
    expect(r.data?.finalDamage).toBe(6);
  });

  it('does not halve fire damage even against raging target', () => {
    const ragingGoblin: CombatActor = { ...goblin };
    const targetRuntime = rt({ actorId: 'm1', conditions: conds('raging'), hpCurrent: 50 });
    // Use applyDamage directly for non-physical types.
    const r = applyDamage({
      runtime: targetRuntime,
      target: ragingGoblin,
      amount: 12,
      type: 'fire',
    });
    expect(r.ok).toBe(true);
    // Goblin no fire resistance and not raging-eligible → full 12.
    const setHpMut = r.mutations.find((m) => m.op === 'set_hp') as Extract<typeof r.mutations[number], { op: 'set_hp' }>;
    expect(setHpMut.hpCurrent).toBe(38); // 50 - 12
  });

  it('does not double-half when target already has innate resistance', () => {
    const physResistant: CombatActor = { ...goblin, resistances: ['slashing'] };
    const targetRuntime = rt({ actorId: 'm1', conditions: conds('raging'), hpCurrent: 50 });
    const r = applyDamage({
      runtime: targetRuntime,
      target: physResistant,
      amount: 12,
      type: 'slashing',
    });
    expect(r.ok).toBe(true);
    // Halved once: 12 → 6.
    const setHp = r.mutations.find((m) => m.op === 'set_hp') as Extract<typeof r.mutations[number], { op: 'set_hp' }>;
    expect(setHp.hpCurrent).toBe(50 - 6);
  });

  it('rage resistance applies even when type is bludgeoning/piercing/slashing', () => {
    const ragingGoblin: CombatActor = { ...goblin };
    const targetRuntime = rt({ actorId: 'm1', conditions: conds('raging'), hpCurrent: 50 });
    const r = applyDamage({
      runtime: targetRuntime,
      target: ragingGoblin,
      amount: 10,
      type: 'piercing',
    });
    expect(r.ok).toBe(true);
    const setHp = r.mutations.find((m) => m.op === 'set_hp') as Extract<typeof r.mutations[number], { op: 'set_hp' }>;
    expect(setHp.hpCurrent).toBe(50 - 5);
  });
});
