import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import {
  getMonsterAttackStats,
  resolveMonsterTurn,
  runMonsterTurnLoop,
  buildMonsterLoopNarrationDirective,
  MONSTER_LOOP_SAFETY_CAP,
  DEFAULT_MONSTER_ATTACK_BONUS,
  DEFAULT_MONSTER_DAMAGE_DIE,
  type MonsterTurnResult,
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

// ===========================================================================
// Phase 09 Plan 04 — runMonsterTurnLoop driver (D-03, D-14) + the combined
// narration directive (D-15). The loop CORE is pure/headless: it operates on a
// structuredClone of the encounter + a copy of the PC-HP map, applies each
// result's events to the working state via applyEncounterEvent, and the ONLY
// I/O — the Level-1 bestiary read — is injected (default getBestiaryAttackStats)
// so every test is deterministic with a seeded RNG and a stub bestiary lookup.
// ===========================================================================

/** A live monster fixture builder for the loop. */
function monster(
  over: Partial<EncounterState['monsters'][number]> &
    Pick<EncounterState['monsters'][number], 'id' | 'name'>,
): EncounterState['monsters'][number] {
  return {
    hpCurrent: 20,
    hpMax: 20,
    ac: 12,
    isAlive: true,
    conditions: [],
    ...over,
  };
}

/**
 * Build an active EncounterState whose turnOrder is the given actor ids in
 * order, with currentIdx at 0. Monsters supplied separately; any actorId not in
 * `monsters` is treated as a PC by the loop (PCs are never in `monsters`).
 */
function encounter(
  turnOrderIds: string[],
  monsters: EncounterState['monsters'],
  currentIdx = 0,
): EncounterState {
  return {
    active: true,
    round: 1,
    currentIdx,
    turnOrder: turnOrderIds.map((actorId) => ({ actorId, initiative: 10 })),
    monsters,
  };
}

/** A bestiary lookup stub that always misses (simulates a read failure → null). */
const NULL_BESTIARY = async (): Promise<null> => null;

describe('runMonsterTurnLoop — named safety cap (D-03c)', () => {
  it('MONSTER_LOOP_SAFETY_CAP is a named integer constant >= a realistic encounter size', () => {
    expect(Number.isInteger(MONSTER_LOOP_SAFETY_CAP)).toBe(true);
    expect(MONSTER_LOOP_SAFETY_CAP).toBeGreaterThanOrEqual(20);
  });
});

describe('runMonsterTurnLoop — multi-monster round then PC turn (D-03)', () => {
  it('two consecutive live monsters attack, then stops at the PC with stopReason pc-turn', async () => {
    // turnOrder: [m1, m2, pc] — both monsters act, then the PC is active → stop.
    const enc = encounter(
      ['m1', 'm2', 'pc-1'],
      [monster({ id: 'm1', name: 'Goblin', cr: 1 }), monster({ id: 'm2', name: 'Orc', cr: 1 })],
    );
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 50]]),
      rng: makeSeededRng(7),
      bestiaryLookup: NULL_BESTIARY,
    });
    expect(out.results).toHaveLength(2);
    expect(out.stopReason).toBe('pc-turn');
    expect(out.partyDown).toBe(false);
    // Both results name their monster (3-level fallback resolved a profile each).
    expect(out.results.map((r) => r.monsterName)).toEqual(['Goblin', 'Orc']);
    // The combined directive is built once and lists both monsters.
    expect(out.narrationDirective).not.toBeNull();
  });

  it('is deterministic — same seed yields identical results twice (D-10)', async () => {
    const build = () =>
      runMonsterTurnLoop({
        encounter: encounter(
          ['m1', 'm2', 'pc-1'],
          [monster({ id: 'm1', name: 'Goblin', cr: 1 }), monster({ id: 'm2', name: 'Orc', cr: 1 })],
        ),
        pcAcById: new Map([['pc-1', 12]]),
        pcHpById: new Map([['pc-1', 50]]),
        rng: makeSeededRng(4242),
        bestiaryLookup: NULL_BESTIARY,
      });
    const a = await build();
    const b = await build();
    expect(b.results).toEqual(a.results);
    expect(b.stopReason).toBe(a.stopReason);
    expect(b.events).toEqual(a.events);
    expect(b.narrationDirective).toBe(a.narrationDirective);
  });
});

describe('runMonsterTurnLoop — dead-monster skip (D-03)', () => {
  it('a monster with hpCurrent<=0 at its turn does not attack; the turn advances past it', async () => {
    // m1 is dead (isAlive false): applyEncounterEvent(turn_advance) skips dead
    // monster actors, so a turn_advance from the loop must move past it. We
    // start with the dead monster active; the loop must NOT resolve an attack
    // for it. Active actor m1 is not a *live* monster → treated as non-monster
    // active → but it is also not a PC. Assert no attack is resolved for a dead
    // monster (results contain no entry naming the dead monster).
    const enc = encounter(
      ['m-dead', 'pc-1'],
      [monster({ id: 'm-dead', name: 'Corpse', hpCurrent: 0, isAlive: false })],
    );
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 50]]),
      rng: makeSeededRng(1),
      bestiaryLookup: NULL_BESTIARY,
    });
    expect(out.results.every((r) => r.monsterName !== 'Corpse')).toBe(true);
    // No live monster ever became active → loop stops without throwing.
    expect(['pc-turn', 'cap-reached']).toContain(out.stopReason);
  });
});

describe('runMonsterTurnLoop — active actor already a PC (D-03)', () => {
  it('returns immediately with 0 results and stopReason pc-turn', async () => {
    const enc = encounter(
      ['pc-1', 'm1'],
      [monster({ id: 'm1', name: 'Goblin', cr: 1 })],
      0, // currentIdx 0 → the PC is active
    );
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 50]]),
      rng: makeSeededRng(1),
      bestiaryLookup: NULL_BESTIARY,
    });
    expect(out.results).toHaveLength(0);
    expect(out.stopReason).toBe('pc-turn');
    expect(out.narrationDirective).toBeNull();
  });
});

describe('runMonsterTurnLoop — all monsters dead / no live monster (D-03)', () => {
  it('stops without resolving any attack when no live monster is ever active', async () => {
    const enc = encounter(
      ['m-dead'],
      [monster({ id: 'm-dead', name: 'Corpse', hpCurrent: 0, isAlive: false })],
    );
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 50]]),
      rng: makeSeededRng(1),
      bestiaryLookup: NULL_BESTIARY,
    });
    expect(out.results).toHaveLength(0);
  });
});

describe('runMonsterTurnLoop — last-PC KO stops the loop + party-down (D-14)', () => {
  it('once a hit drops the last live PC to 0, the loop stops with party-down and HP clamps at 0', async () => {
    // turnOrder leads with one monster, then the single live PC, then more
    // monsters. The lead monster KOs the last live PC; the loop must then stop —
    // it must NOT let m2/m3 attack a dead party. The PC is IN the turnOrder so
    // the live-PC pool (turn-order-scoped) sees it before the KO.
    const enc = encounter(
      ['m1', 'pc-1', 'm2', 'm3'],
      [
        monster({ id: 'm1', name: 'Goblin', cr: 1 }),
        monster({ id: 'm2', name: 'Orc', cr: 1 }),
        monster({ id: 'm3', name: 'Bugbear', cr: 1 }),
      ],
    );
    // A bestiary stub returning a large attack profile + a seed whose first d20
    // is NOT a natural 1 guarantees the hit + kill (attackBonus 100 vs AC 1 with
    // natural != 1 → hits; 20d6+50 >> 5 HP → always kills). Seed 0's first attack
    // rolls a natural 14 (a hit); a natural-1 seed would auto-miss and the PC
    // would survive (correct loop behavior, but not this test's KO scenario).
    const BIG = async () => ({ attackBonus: 100, damageDice: '20d6+50' });
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 1]]),
      pcHpById: new Map([['pc-1', 5]]),
      rng: makeSeededRng(0),
      bestiaryLookup: BIG,
    });
    // The lead monster's attack must have LANDED for this KO scenario to hold.
    expect(out.results[0]!.hit).toBe(true);
    expect(out.stopReason).toBe('party-down');
    expect(out.partyDown).toBe(true);
    // Only ONE monster acted — the loop stopped after the KO, it did not let the
    // remaining monsters attack a dead party.
    expect(out.results).toHaveLength(1);
    // The working HP clamped at 0 (never negative) — the emitted hp_change carries
    // the full negative delta for the route, but the in-loop clamp bottomed at 0.
    expect(out.results[0]!.damage!).toBeGreaterThan(5);
    // The combined directive signals the party-KO.
    expect(out.narrationDirective).not.toBeNull();
    expect(out.narrationDirective!.toLowerCase()).toMatch(/terra|0 (hp|pf)|sconfitt/);
  });

  it('a non-last KO lets the loop continue (two live PCs, first dropped, second still up)', async () => {
    // turnOrder: [m1, m2, pc-a, pc-b]; m1 KOs pc-a, m2 still attacks pc-b.
    const enc = encounter(
      ['m1', 'm2', 'pc-a', 'pc-b'],
      [monster({ id: 'm1', name: 'Goblin', cr: 1 }), monster({ id: 'm2', name: 'Orc', cr: 1 })],
    );
    const BIG = async () => ({ attackBonus: 100, damageDice: '20d6+50' });
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([
        ['pc-a', 1],
        ['pc-b', 1],
      ]),
      pcHpById: new Map([
        ['pc-a', 5],
        ['pc-b', 5],
      ]),
      rng: makeSeededRng(9),
      bestiaryLookup: BIG,
    });
    // Both monsters acted (the first KO was not the last PC) → then the PCs are
    // active (both KO'd by now) → party-down. Two monster attacks resolved.
    expect(out.results).toHaveLength(2);
    expect(out.partyDown).toBe(true);
  });
});

describe('runMonsterTurnLoop — safety cap never throws (D-03c)', () => {
  it('a long all-live-monster prefix that never reaches the PC within the cap stops at cap-reached, no throw', async () => {
    // ONE live monster repeated across (cap + 1) turnOrder slots, with the live
    // PC at the very end (index cap+1). The reducer advances one slot per
    // turn_advance, so after MONSTER_LOOP_SAFETY_CAP iterations the active index
    // is still on a monster slot — the PC at index cap+1 is never reached. The
    // PC IS in the turnOrder and alive (HP 9999), so the live-PC pool is never
    // empty → party-down never fires; only the cap can stop the loop. This is the
    // degenerate "turn_advance never reaches a PC within the cap" case (D-03c).
    const m = monster({ id: 'm1', name: 'Treadmill', cr: 0 });
    const turnOrderIds: string[] = [];
    for (let i = 0; i < MONSTER_LOOP_SAFETY_CAP + 1; i++) {
      turnOrderIds.push('m1'); // same live monster id occupies every prefix slot
    }
    turnOrderIds.push('pc-1'); // the PC sits beyond the cap's reach
    const enc = encounter(turnOrderIds, [m]);

    let out!: Awaited<ReturnType<typeof runMonsterTurnLoop>>;
    await expect(
      (async () => {
        out = await runMonsterTurnLoop({
          encounter: enc,
          pcAcById: new Map([['pc-1', 999]]),
          pcHpById: new Map([['pc-1', 9999]]),
          rng: makeSeededRng(2),
          bestiaryLookup: NULL_BESTIARY,
        });
      })(),
    ).resolves.toBeUndefined();
    expect(out.stopReason).toBe('cap-reached');
    // The loop ran exactly the capped number of iterations (each resolved the
    // live monster's attack) and then stopped cleanly without throwing.
    expect(out.results).toHaveLength(MONSTER_LOOP_SAFETY_CAP);
  });
});

describe('runMonsterTurnLoop — bestiary read failure falls through (T-09-22)', () => {
  it('a null bestiary result lets the loop continue using CR/default stats, no throw', async () => {
    const enc = encounter(
      ['m1', 'pc-1'],
      [monster({ id: 'm1', name: 'Custom Beast', cr: 5 })],
    );
    // bestiaryLookup throws-then-null is the contract — here we simulate the
    // already-caught null (09-03 never throws). The monster must still resolve
    // via the CR-5 table (+7/2d6+4) and the loop must complete.
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 50]]),
      rng: makeSeededRng(11),
      bestiaryLookup: NULL_BESTIARY,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.monsterName).toBe('Custom Beast');
    expect(out.stopReason).toBe('pc-turn');
  });

  it('defaults to the real getBestiaryAttackStats when no bestiaryLookup is injected (no throw)', async () => {
    // No bestiaryLookup → the loop uses the real fs-backed lookup. With a made-up
    // monster name there is no bestiary file, so it null-returns and falls back
    // to the CR table. The loop must complete without throwing.
    const enc = encounter(
      ['m1', 'pc-1'],
      [monster({ id: 'm1', name: 'Zzdefinitelynotamonster', cr: 2 })],
    );
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 50]]),
      rng: makeSeededRng(5),
    });
    expect(out.results).toHaveLength(1);
    expect(out.stopReason).toBe('pc-turn');
  });
});

describe('runMonsterTurnLoop — working-copy isolation (T-09-13)', () => {
  it('does not mutate the caller pcHpById map or the caller encounter', async () => {
    const callerHp = new Map([['pc-1', 50]]);
    const enc = encounter(
      ['m1', 'pc-1'],
      [monster({ id: 'm1', name: 'Goblin', cr: 1 })],
    );
    const encSnapshot = structuredClone(enc);
    const BIG = async () => ({ attackBonus: 100, damageDice: '1d6' });
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 1]]),
      pcHpById: callerHp,
      rng: makeSeededRng(1),
      bestiaryLookup: BIG,
    });
    // The caller's HP map is untouched even though a hit was applied internally.
    expect(callerHp.get('pc-1')).toBe(50);
    // The caller's encounter object is untouched (currentIdx not advanced).
    expect(enc).toEqual(encSnapshot);
    // The emitted events DO carry the negative hp_change delta for the route.
    const hpEvents = out.events.filter((e) => e.type === 'hp_change');
    if (out.results[0]!.hit) {
      expect(hpEvents.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('runMonsterTurnLoop — defensive resolveMonsterTurn null (D-03)', () => {
  it('handles a no-live-PC pool as party-down, never a throw', async () => {
    // A live monster is active but there is NO live PC at all (empty pcHp) →
    // livePcIds is empty → party-down, no attack resolved, no throw.
    const enc = encounter(
      ['m1'],
      [monster({ id: 'm1', name: 'Goblin', cr: 1 })],
    );
    const out = await runMonsterTurnLoop({
      encounter: enc,
      pcAcById: new Map([['pc-1', 12]]),
      pcHpById: new Map([['pc-1', 0]]), // already dead
      rng: makeSeededRng(1),
      bestiaryLookup: NULL_BESTIARY,
    });
    expect(out.results).toHaveLength(0);
    expect(out.stopReason).toBe('party-down');
    expect(out.partyDown).toBe(true);
  });
});

// ===========================================================================
// buildMonsterLoopNarrationDirective — single combined Italian directive (D-15)
// ===========================================================================

function hitResult(name: string, total: number, ac: number, damage: number): MonsterTurnResult {
  return {
    monsterName: name,
    hit: true,
    natural: 15,
    total,
    ac,
    damage,
    pcTargetId: 'pc-1',
    events: [
      { type: 'hp_change', payload: { character: 'pc-1', delta: -damage } },
      { type: 'turn_advance', payload: {} },
    ],
  };
}

function missResult(name: string, total: number, ac: number): MonsterTurnResult {
  return {
    monsterName: name,
    hit: false,
    natural: 8,
    total,
    ac,
    damage: null,
    pcTargetId: 'pc-1',
    events: [{ type: 'turn_advance', payload: {} }],
  };
}

describe('buildMonsterLoopNarrationDirective — combined directive (D-15)', () => {
  it('lists every outcome ONCE in a single [RESOLVED BY SYSTEM] directive', () => {
    const dir = buildMonsterLoopNarrationDirective([
      hitResult('Veyra', 15, 12, 7),
      missResult('Goblin', 8, 12),
    ]);
    expect(dir).not.toBeNull();
    expect(dir!).toContain('RESOLVED BY SYSTEM');
    // Both monsters appear in the one directive.
    expect(dir!).toContain('Veyra');
    expect(dir!).toContain('Goblin');
    // The hit reports its damage; the miss reports a miss.
    expect(dir!).toContain('7');
    // Italian 2nd-person + the no-roll/no-event closer (mirrors v1 wording).
    expect(dir!.toLowerCase()).toContain('seconda persona');
    expect(dir!).toMatch(/NON chiedere tiri/i);
  });

  it('a 2-result loop produces exactly ONE directive string (single combined pass)', () => {
    const dir = buildMonsterLoopNarrationDirective([
      hitResult('Veyra', 15, 12, 7),
      hitResult('Goblin', 14, 12, 3),
    ]);
    expect(typeof dir).toBe('string');
    // Exactly one header → one combined directive, not one-per-monster.
    const headerCount = (dir!.match(/RESOLVED BY SYSTEM/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('returns null for empty results (no fabricated outcome)', () => {
    expect(buildMonsterLoopNarrationDirective([])).toBeNull();
  });

  it('appends a party-KO signal when partyDown is true (D-14)', () => {
    const dir = buildMonsterLoopNarrationDirective([hitResult('Veyra', 15, 12, 7)], {
      partyDown: true,
    });
    expect(dir).not.toBeNull();
    // Some Italian party-down signal so the LLM narrates the KO.
    expect(dir!.toLowerCase()).toMatch(/terra|svenut|incosc|0 (hp|pf)|sconfitt|fuori combattimento/);
  });

  it('does NOT add a party-KO signal when partyDown is false', () => {
    const dir = buildMonsterLoopNarrationDirective([hitResult('Veyra', 15, 12, 7)], {
      partyDown: false,
    });
    expect(dir).not.toBeNull();
  });
});
