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
    { slug: 'longsword', qty: 1, equipped: true },
    { slug: 'dagger', qty: 1, equipped: true },
  ],
  hitDiceMax: 5,
  hitDieSize: 10,
};

const weakling: Character = {
  ...fighter,
  id: 'pc2',
  name: 'Yorin',
  abilities: { STR: 8, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
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

const dagger: WeaponSpec = {
  name: 'Dagger',
  damage: '1d4',
  damageType: 'piercing',
  profGroup: 'Simple',
  useDex: false, // STR for off-hand validation symmetry
  properties: ['finesse', 'light', 'thrown'],
};

const longsword: WeaponSpec = {
  name: 'Longsword',
  damage: '1d8',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['versatile'],
};

describe('makeAttack — two-weapon fighting (PHB §3.15)', () => {
  it('offHand without light weapon errors offhand_requires_light_weapon', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: longsword,
      attackerRuntime: rt(fighter.id, { turnState: { actionUsed: true } }),
      targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
      offHand: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('offhand_requires_light_weapon');
    expect(r.rolls).toEqual([]);
    expect(r.mutations).toEqual([]);
  });

  it('offHand without prior Attack action errors offhand_requires_attack_action', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: dagger,
      attackerRuntime: rt(fighter.id, { turnState: { actionUsed: false } }),
      targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
      offHand: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('offhand_requires_attack_action');
  });

  it('offHand when bonus already used errors bonus_already_used', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: dagger,
      attackerRuntime: rt(fighter.id, { turnState: { actionUsed: true, bonusUsed: true } }),
      targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
      offHand: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bonus_already_used');
  });

  it('offHand when off-hand attack already used errors offhand_already_used', () => {
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: dagger,
      attackerRuntime: rt(fighter.id, {
        turnState: { actionUsed: true, offHandAttackUsed: true },
      }),
      targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
      offHand: true,
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('offhand_already_used');
  });

  it('offHand on light weapon: emits consume_action kind:bonus and mark_offhand_attack', () => {
    // Iterate seeds until we hit
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: dagger,
        attackerRuntime: rt(fighter.id, { turnState: { actionUsed: true } }),
        targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
        offHand: true,
      }, makeSeededRng(seed));
      if (r.ok || r.error === 'miss') {
        const consume = r.mutations.find((m) => m.op === 'consume_action') as { kind?: string } | undefined;
        expect(consume).toBeDefined();
        expect(consume!.kind).toBe('bonus');
        const mark = r.mutations.find((m) => m.op === 'mark_offhand_attack');
        expect(mark).toBeDefined();
        return;
      }
    }
    throw new Error('No resolved attack across 200 seeds');
  });

  it('offHand damage formula has NO ability mod when STR mod is positive', () => {
    // STR 16 → +3 mod. Off-hand should drop the +3 from the damage formula.
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: dagger,
        attackerRuntime: rt(fighter.id, { turnState: { actionUsed: true } }),
        targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
        offHand: true,
      }, makeSeededRng(seed));
      if (r.ok && r.rolls.length >= 2) {
        const damageRoll = r.rolls[1]!;
        // Formula should be just '1d4' (no '+3').
        expect(damageRoll.formula).toBe('1d4');
        expect(damageRoll.modifier).toBe(0);
        return;
      }
    }
    throw new Error('No hit across 200 seeds');
  });

  it('offHand damage formula DOES add ability mod when STR mod is negative', () => {
    // STR 8 → -1 mod. Off-hand keeps the -1 (PHB exception).
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: weakling,
        target: goblin,
        weapon: dagger,
        attackerRuntime: rt(weakling.id, { turnState: { actionUsed: true } }),
        targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
        offHand: true,
      }, makeSeededRng(seed));
      if (r.ok && r.rolls.length >= 2) {
        const damageRoll = r.rolls[1]!;
        // STR mod -1 must remain.
        expect(damageRoll.formula).toBe('1d4-1');
        expect(damageRoll.modifier).toBe(-1);
        return;
      }
    }
    throw new Error('No hit across 200 seeds');
  });

  it('non-offHand attack with positive STR mod still includes the mod (regression)', () => {
    // Ensure we didn't break the default damage formula.
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: dagger,
        attackerRuntime: rt(fighter.id, { turnState: newTurnState() }),
        targetRuntime: rt(goblin.id, { hpCurrent: 7 }),
      }, makeSeededRng(seed));
      if (r.ok && r.rolls.length >= 2) {
        const damageRoll = r.rolls[1]!;
        expect(damageRoll.formula).toBe('1d4+3');
        expect(damageRoll.modifier).toBe(3);
        return;
      }
    }
    throw new Error('No hit across 200 seeds');
  });
});
