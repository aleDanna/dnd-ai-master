import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import type { WeaponSpec } from '@/engine/combat/attack';
import { makeSeededRng } from '@/engine/rand';
import { newTurnState } from '@/engine/combat/turn-state';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  TurnState,
} from '@/engine/types';

function rt(actorId: string, opts: { hpCurrent?: number; turnState?: Partial<TurnState> } = {}): ActorRuntimeState {
  return {
    actorId,
    hpCurrent: opts.hpCurrent ?? 30,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    turnState: { ...newTurnState(), ...(opts.turnState ?? {}) },
  };
}

const fighter: Character = {
  id: 'pc1',
  name: 'Tharion',
  level: 5,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
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
  inventory: [
    { slug: 'halberd', qty: 1, equipped: true },
    { slug: 'light-crossbow', qty: 1, equipped: false },
    { slug: 'crossbow-bolt', qty: 20, equipped: false },
  ],
  hitDiceMax: 5,
  hitDieSize: 10,
};

const fighterNoBolts: Character = {
  ...fighter,
  inventory: [{ slug: 'light-crossbow', qty: 1, equipped: true }],
};

const goblin: CombatActor = {
  id: 'm1',
  kind: 'monster',
  name: 'Goblin',
  hpMax: 7,
  ac: 12,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2,
  initiativeBonus: 2,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
};

const halberd: WeaponSpec = {
  name: 'Halberd',
  damage: '1d10',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['heavy', 'reach', 'two-handed'],
};

const longsword: WeaponSpec = {
  name: 'Longsword',
  damage: '1d8',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['versatile'],
};

const lightCrossbow: WeaponSpec = {
  name: 'Light Crossbow',
  damage: '1d8',
  damageType: 'piercing',
  profGroup: 'Simple',
  useDex: true,
  properties: ['ammunition', 'loading', 'two-handed'],
  ammoSlug: 'crossbow-bolt',
  range: { normal: 80, long: 320 },
};

const lightCrossbowMissingAmmo: WeaponSpec = {
  ...lightCrossbow,
  ammoSlug: undefined,
};

describe('makeAttack — reach property (PHB §9.4)', () => {
  it('halberd at 10ft melee succeeds (reach extends to 10ft)', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: halberd,
        meleeRange: 10,
      }, makeSeededRng(seed));
      // Either hit or normal miss — but never out_of_reach
      expect(r.error).not.toBe('out_of_reach');
      if (r.ok || r.error === 'miss') return;
    }
    throw new Error('No resolved attack across 100 seeds');
  });

  it('non-reach longsword at 10ft errors out_of_reach (no rolls, no mutations)', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      meleeRange: 10,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('out_of_reach');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('halberd at 15ft errors out_of_reach (beyond 10ft reach)', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: halberd,
      meleeRange: 15,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('out_of_reach');
  });

  it('reach default: omitting meleeRange uses 5ft for non-reach, 10ft for reach (no error)', () => {
    // Halberd with no meleeRange → defaults to reach=10, in-reach.
    for (let seed = 0; seed < 100; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: halberd,
      }, makeSeededRng(seed));
      expect(r.error).not.toBe('out_of_reach');
      if (r.ok || r.error === 'miss') return;
    }
    throw new Error('No resolved attack');
  });
});

describe('makeAttack — loading property (PHB §9.4)', () => {
  it('first crossbow shot with loadingShotUsed=false succeeds; emits mark_loading_shot', () => {
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: lightCrossbow,
        attackerRuntime: rt(fighter.id, { turnState: newTurnState() }),
        targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
        ranged: true,
      }, makeSeededRng(seed));
      if (r.ok || r.error === 'miss') {
        const mark = r.mutations.find((m) => m.op === 'mark_loading_shot');
        expect(mark).toBeDefined();
        return;
      }
    }
    throw new Error('No resolved attack');
  });

  it('second crossbow shot when loadingShotUsed=true errors loading_shot_already_used', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: lightCrossbow,
      attackerRuntime: rt(fighter.id, { turnState: { loadingShotUsed: true } }),
      targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
      ranged: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('loading_shot_already_used');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });
});

describe('makeAttack — ammunition property (PHB §9.4)', () => {
  it('attack with available ammo emits consume_ammo on hit/miss', () => {
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: lightCrossbow,
        attackerRuntime: rt(fighter.id, { turnState: newTurnState() }),
        targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
        ranged: true,
      }, makeSeededRng(seed));
      if (r.ok || r.error === 'miss') {
        const consume = r.mutations.find((m) => m.op === 'consume_ammo') as { ammoSlug?: string; qty?: number } | undefined;
        expect(consume).toBeDefined();
        expect(consume!.ammoSlug).toBe('crossbow-bolt');
        expect(consume!.qty).toBe(1);
        return;
      }
    }
    throw new Error('No resolved attack');
  });

  it('attack with empty ammo inventory errors out_of_ammo (no consumption)', () => {
    const r = makeAttack({
      attacker: fighterNoBolts,
      target: goblin,
      weapon: lightCrossbow,
      ranged: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('out_of_ammo');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('weapon with ammunition property but no ammoSlug errors weapon_missing_ammoSlug', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: lightCrossbowMissingAmmo,
      ranged: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('weapon_missing_ammoSlug');
  });
});
