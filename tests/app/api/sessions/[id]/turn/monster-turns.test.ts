import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import {
  getMonsterAttackStats,
  resolveMonsterTurn,
  DEFAULT_MONSTER_ATTACK_BONUS,
  DEFAULT_MONSTER_DAMAGE_DIE,
} from '@/app/api/sessions/[id]/turn/monster-turns';
import { rollDamage } from '@/engine/dice';
import { makeSeededRng } from '@/engine/rand';

/**
 * Phase 09 Plan 02 — headless unit suite for the pure monster-turn primitives
 * (Wave 1). `getMonsterAttackStats` and `resolveMonsterTurn` are PURE functions:
 * no db mock, no tmpfs, no provider — just plain inputs + a seeded RNG.
 *
 * Mirrors the v1 conventions in
 * tests/app/api/sessions/[id]/turn/combat-resolver.test.ts (vitest import,
 * EncounterState fixtures) + dice.test.ts (makeSeededRng for determinism).
 */

// ---------------------------------------------------------------------------
// getMonsterAttackStats — CR table (D-05) + named-constant default (D-06)
// ---------------------------------------------------------------------------

describe('getMonsterAttackStats — CR table (D-05)', () => {
  it('CR floor (0) → +4 / 1d6 (goblin tier)', () => {
    expect(getMonsterAttackStats({ cr: 0 })).toEqual({ attackBonus: 4, damageDice: '1d6' });
  });

  it('CR mid (5) → +7 / 2d6+4 (troll, exact cross-validated row)', () => {
    expect(getMonsterAttackStats({ cr: 5 })).toEqual({ attackBonus: 7, damageDice: '2d6+4' });
  });

  it('CR high (17) → +14 / 2d10+8 (adult red dragon)', () => {
    expect(getMonsterAttackStats({ cr: 17 })).toEqual({ attackBonus: 14, damageDice: '2d10+8' });
  });

  it('nearest-floor: CR 2.7 → the CR 2 row (largest key <= cr)', () => {
    expect(getMonsterAttackStats({ cr: 2.7 })).toEqual({ attackBonus: 5, damageDice: '1d8+3' });
  });

  it('nearest-floor: CR 1/4 (0.25) → the CR 0 row', () => {
    expect(getMonsterAttackStats({ cr: 0.25 })).toEqual({ attackBonus: 4, damageDice: '1d6' });
  });

  it('nearest-floor: CR 7 (between 6 and 8) → the CR 6 row', () => {
    expect(getMonsterAttackStats({ cr: 7 })).toEqual({ attackBonus: 7, damageDice: '2d8+4' });
  });

  it('above-range: CR 999 → the CR 17 row (largest key <= cr — documented choice)', () => {
    expect(getMonsterAttackStats({ cr: 999 })).toEqual({ attackBonus: 14, damageDice: '2d10+8' });
  });
});

describe('getMonsterAttackStats — default fallback (D-06)', () => {
  it('no cr, no bestiary → named-constant default (+4 / 1d6)', () => {
    expect(getMonsterAttackStats({})).toEqual({
      attackBonus: DEFAULT_MONSTER_ATTACK_BONUS,
      damageDice: DEFAULT_MONSTER_DAMAGE_DIE,
    });
  });

  it('named constants are exactly +4 / 1d6 (mirror v1 DEFAULT_MONSTER_AC pattern)', () => {
    expect(DEFAULT_MONSTER_ATTACK_BONUS).toBe(4);
    expect(DEFAULT_MONSTER_DAMAGE_DIE).toBe('1d6');
  });

  it('malformed cr = -1 → default (never throws)', () => {
    expect(() => getMonsterAttackStats({ cr: -1 })).not.toThrow();
    expect(getMonsterAttackStats({ cr: -1 })).toEqual({
      attackBonus: DEFAULT_MONSTER_ATTACK_BONUS,
      damageDice: DEFAULT_MONSTER_DAMAGE_DIE,
    });
  });

  it('malformed cr = NaN → default', () => {
    expect(getMonsterAttackStats({ cr: NaN })).toEqual({
      attackBonus: DEFAULT_MONSTER_ATTACK_BONUS,
      damageDice: DEFAULT_MONSTER_DAMAGE_DIE,
    });
  });

  it('malformed cr = Infinity → default', () => {
    expect(getMonsterAttackStats({ cr: Infinity })).toEqual({
      attackBonus: DEFAULT_MONSTER_ATTACK_BONUS,
      damageDice: DEFAULT_MONSTER_DAMAGE_DIE,
    });
  });
});

describe('getMonsterAttackStats — bestiary precedence (D-04 feed)', () => {
  it('bestiary profile wins over cr/default', () => {
    expect(
      getMonsterAttackStats({ cr: 5, bestiary: { attackBonus: 5, damageDice: '2d6+3' } }),
    ).toEqual({ attackBonus: 5, damageDice: '2d6+3' });
  });

  it('bestiary profile wins even with no cr', () => {
    expect(
      getMonsterAttackStats({ bestiary: { attackBonus: 8, damageDice: '1d12+4' } }),
    ).toEqual({ attackBonus: 8, damageDice: '1d12+4' });
  });

  it('bestiary null → falls through to cr/default', () => {
    expect(getMonsterAttackStats({ cr: 5, bestiary: null })).toEqual({
      attackBonus: 7,
      damageDice: '2d6+4',
    });
  });
});

describe('getMonsterAttackStats — every table damageDice is rollDamage-consumable', () => {
  // Exercise every key the table can return through rollDamage with a seeded RNG;
  // a successful roll proves each damageDice matches the dice.ts FORMULA_RE grammar.
  const CRS = [0, 1, 2, 3, 4, 5, 6, 8, 12, 17];
  for (const cr of CRS) {
    it(`CR ${cr} damageDice rolls > 0 via rollDamage`, () => {
      const { damageDice } = getMonsterAttackStats({ cr });
      const roll = rollDamage(damageDice, {}, makeSeededRng(1));
      expect(roll.total).toBeGreaterThan(0);
    });
  }

  it('the default damageDice is rollDamage-consumable', () => {
    const roll = rollDamage(DEFAULT_MONSTER_DAMAGE_DIE, {}, makeSeededRng(1));
    expect(roll.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveMonsterTurn — v1 hit rule (D-09) + injected RNG (D-10) + target (D-11)
// ---------------------------------------------------------------------------

/**
 * A single live monster fixture (mirrors MONSTER_ACTIVE_ENCOUNTER from
 * PATTERNS.md:186-197). resolveMonsterTurn only reads `monster.name`, so a
 * minimal monster shape is enough.
 */
const VEYRA: EncounterState['monsters'][number] = {
  id: 'veyra-1',
  name: 'Veyra',
  hpCurrent: 30,
  hpMax: 30,
  ac: 12,
  isAlive: true,
  conditions: [],
};

/**
 * Find a seed whose FIRST d20 face (modifier 0) equals `target`. Mirrors how the
 * engine seeds for a specific natural: roll with the same rng construction the
 * function will use, then reuse a FRESH makeSeededRng(seed) in the assertion so
 * the d20 draw is identical.
 */
function seedForNatural(target: number): number {
  for (let s = 0; s < 100000; s++) {
    const rng = makeSeededRng(s);
    // resolveMonsterTurn draws the TARGET pick first (single-PC pool → one draw
    // of intInclusive(0,0)), THEN the d20. Mirror that draw order here so the
    // seed reproduces the same natural inside the function.
    rng.intInclusive(0, 0); // target pick (single live PC)
    const natural = rng.intInclusive(1, 20);
    if (natural === target) return s;
  }
  throw new Error(`no seed found for natural ${target}`);
}

describe('resolveMonsterTurn — defensive edge (D-11)', () => {
  it('empty livePcIds → returns null (never throws)', () => {
    const out = resolveMonsterTurn({
      monster: VEYRA,
      attackBonus: 5,
      damageDice: '1d6',
      livePcIds: [],
      pcAcById: new Map(),
      rng: makeSeededRng(1),
    });
    expect(out).toBeNull();
  });
});

describe('resolveMonsterTurn — v1 hit rule boundaries (D-09)', () => {
  it('natural 1 → auto-miss regardless of bonus/AC; events = [turn_advance]; damage null', () => {
    const seed = seedForNatural(1);
    const out = resolveMonsterTurn({
      monster: VEYRA,
      attackBonus: 100, // huge bonus cannot save a nat-1
      damageDice: '1d6',
      livePcIds: ['pc-1'],
      pcAcById: new Map([['pc-1', 1]]), // trivially low AC
      rng: makeSeededRng(seed),
    });
    expect(out).not.toBeNull();
    expect(out!.natural).toBe(1);
    expect(out!.hit).toBe(false);
    expect(out!.damage).toBeNull();
    expect(out!.events).toEqual([{ type: 'turn_advance', payload: {} }]);
  });

  it('natural 20 → auto-hit even when total < ac; hp_change + turn_advance; damage rolled', () => {
    const seed = seedForNatural(20);
    const out = resolveMonsterTurn({
      monster: VEYRA,
      attackBonus: 0,
      damageDice: '1d6',
      livePcIds: ['pc-1'],
      pcAcById: new Map([['pc-1', 999]]), // unreachable AC — only nat-20 hits
      rng: makeSeededRng(seed),
    });
    expect(out).not.toBeNull();
    expect(out!.natural).toBe(20);
    expect(out!.hit).toBe(true);
    expect(out!.damage).not.toBeNull();
    expect(out!.damage!).toBeGreaterThan(0);
    expect(out!.events).toEqual([
      { type: 'hp_change', payload: { character: 'pc-1', delta: -out!.damage! } },
      { type: 'turn_advance', payload: {} },
    ]);
  });

  it('total === ac (natural not 1/20) → HIT', () => {
    // natural 10 + bonus 4 = total 14; set AC = 14 → total === ac → hit.
    const seed = seedForNatural(10);
    const out = resolveMonsterTurn({
      monster: VEYRA,
      attackBonus: 4,
      damageDice: '1d6',
      livePcIds: ['pc-1'],
      pcAcById: new Map([['pc-1', 14]]),
      rng: makeSeededRng(seed),
    });
    expect(out).not.toBeNull();
    expect(out!.natural).toBe(10);
    expect(out!.total).toBe(14);
    expect(out!.hit).toBe(true);
    expect(out!.events[0]!.type).toBe('hp_change');
  });

  it('total === ac - 1 (natural not 1/20) → MISS; events = [turn_advance]', () => {
    // natural 10 + bonus 4 = total 14; set AC = 15 → total === ac-1 → miss.
    const seed = seedForNatural(10);
    const out = resolveMonsterTurn({
      monster: VEYRA,
      attackBonus: 4,
      damageDice: '1d6',
      livePcIds: ['pc-1'],
      pcAcById: new Map([['pc-1', 15]]),
      rng: makeSeededRng(seed),
    });
    expect(out).not.toBeNull();
    expect(out!.natural).toBe(10);
    expect(out!.total).toBe(14);
    expect(out!.hit).toBe(false);
    expect(out!.damage).toBeNull();
    expect(out!.events).toEqual([{ type: 'turn_advance', payload: {} }]);
  });
});

describe('resolveMonsterTurn — no crit-doubling on nat-20 (D-09)', () => {
  it('nat-20 damage uses a single dice roll (no doubled dice)', () => {
    const seed = seedForNatural(20);
    // damageDice 1d6 → max 6 with no crit-doubling. Run many seeds-equivalent by
    // asserting the rolled damage never exceeds the single-die maximum.
    const out = resolveMonsterTurn({
      monster: VEYRA,
      attackBonus: 0,
      damageDice: '1d6',
      livePcIds: ['pc-1'],
      pcAcById: new Map([['pc-1', 999]]),
      rng: makeSeededRng(seed),
    });
    expect(out).not.toBeNull();
    expect(out!.hit).toBe(true);
    // 1d6 single roll → [1,6]; a doubled (crit) 2d6 could exceed 6.
    expect(out!.damage!).toBeGreaterThanOrEqual(1);
    expect(out!.damage!).toBeLessThanOrEqual(6);
  });
});

describe('resolveMonsterTurn — determinism (D-10)', () => {
  it('same seed reproduces identical (natural,total,hit,damage,pcTargetId) twice', () => {
    const SEED = 4242;
    const args = {
      monster: VEYRA,
      attackBonus: 4,
      damageDice: '2d6+4',
      livePcIds: ['a', 'b', 'c'],
      pcAcById: new Map([
        ['a', 14],
        ['b', 14],
        ['c', 14],
      ]),
    };
    const first = resolveMonsterTurn({ ...args, rng: makeSeededRng(SEED) })!;
    const second = resolveMonsterTurn({ ...args, rng: makeSeededRng(SEED) })!;
    expect(second.natural).toBe(first.natural);
    expect(second.total).toBe(first.total);
    expect(second.hit).toBe(first.hit);
    expect(second.damage).toBe(first.damage);
    expect(second.pcTargetId).toBe(first.pcTargetId);
    expect(second.events).toEqual(first.events);
  });
});

describe('resolveMonsterTurn — random live-PC target (D-11)', () => {
  it('1v1 collapse: single-element livePcIds always returns that PC', () => {
    for (const seed of [1, 2, 3, 7, 99, 12345]) {
      const out = resolveMonsterTurn({
        monster: VEYRA,
        attackBonus: 4,
        damageDice: '1d6',
        livePcIds: ['solo-pc'],
        pcAcById: new Map([['solo-pc', 14]]),
        rng: makeSeededRng(seed),
      });
      expect(out).not.toBeNull();
      expect(out!.pcTargetId).toBe('solo-pc');
    }
  });

  it('multi-PC: target is always drawn from the live pool', () => {
    const pool = ['a', 'b', 'c'];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const out = resolveMonsterTurn({
        monster: VEYRA,
        attackBonus: 4,
        damageDice: '1d6',
        livePcIds: pool,
        pcAcById: new Map([
          ['a', 14],
          ['b', 14],
          ['c', 14],
        ]),
        rng: makeSeededRng(seed),
      });
      expect(out).not.toBeNull();
      expect(pool).toContain(out!.pcTargetId);
    }
  });

  it('over many seeds the multi-PC pick reaches more than one PC (random, not fixed)', () => {
    const pool = ['a', 'b', 'c'];
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const out = resolveMonsterTurn({
        monster: VEYRA,
        attackBonus: 4,
        damageDice: '1d6',
        livePcIds: pool,
        pcAcById: new Map([
          ['a', 14],
          ['b', 14],
          ['c', 14],
        ]),
        rng: makeSeededRng(seed),
      });
      seen.add(out!.pcTargetId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
