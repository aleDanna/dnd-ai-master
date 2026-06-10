import { describe, it, expect, vi } from 'vitest';
import {
  runEncounterOpener,
  extractMonsterName,
} from '../../../../../../src/app/api/sessions/[id]/turn/encounter-opener';

/**
 * Phase 10 Plan 01 — RED tests for the pure encounter-opener contract.
 *
 * `runEncounterOpener` is a pure synchronous function: no DB, no fs, no I/O.
 * The bestiaryLookup is dependency-injected (vi.fn()), mirroring the
 * combat-resolver.test.ts convention of injecting fixtures at the boundary.
 *
 * Behaviors under test:
 *   1. Happy path — monster_spawn + initiative_set, correct shapes.
 *   2. Empty party → [] (never open combat with no PCs — REQ-047 / D-01 guard).
 *   3. REQ-047 invariant — no damage event on the opening turn.
 *   4. Null bestiary fallback — opener degrades to a CR-derived default HP, NEVER throws.
 *
 * INFO-9 note: PC rows carry NO initiativeBonus in the characters schema
 * (ac/hpMax only) — the opener uses initiativeBonus 0 for PCs by design.
 */

// ---------------------------------------------------------------------------
// Minimal in-memory snapshot fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal CharacterDbRow-shaped PC row. Only the fields the opener reads are
 * supplied; the rest of the Character schema is irrelevant for this pure function.
 */
type MinimalPc = { id: string; name: string };

const PC_UUID = '11111111-1111-4111-8111-111111111111';
const PC_UUID_2 = '22222222-2222-4222-8222-222222222222';

/** Snapshot with one PC — the standard happy-path fixture. */
const SNAPSHOT_ONE_PC = {
  party: [{ id: PC_UUID, name: 'Aria' }] as MinimalPc[],
};

/** Snapshot with two PCs — verifies initiative_set.order.length === party.length + 1. */
const SNAPSHOT_TWO_PC = {
  party: [
    { id: PC_UUID, name: 'Aria' },
    { id: PC_UUID_2, name: 'Bryn' },
  ] as MinimalPc[],
};

/** Empty party — opener must return [] without attempting to open combat. */
const SNAPSHOT_EMPTY_PARTY = {
  party: [] as MinimalPc[],
};

/** Canned bestiary statblock returned by the happy-path lookup mock. */
const GOBLIN_STATS = { hpMax: 7, ac: 15, cr: 0.25 };

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('runEncounterOpener — happy path', () => {
  it('returns exactly a monster_spawn event and an initiative_set event', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);

    expect(result.length).toBe(2);
    expect(result[0]!.type).toBe('monster_spawn');
    expect(result[1]!.type).toBe('initiative_set');
  });

  it('monster_spawn carries a non-empty id, the monster name, and hpMax from the lookup', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);

    const spawn = result[0]!;
    expect(spawn.type).toBe('monster_spawn');
    // Payload must have id, name, hpMax
    const p = spawn.payload as { id: string; name: string; hpMax: number };
    expect(typeof p.id).toBe('string');
    expect(p.id.length).toBeGreaterThan(0);
    expect(p.name).toBe('goblin');
    expect(p.hpMax).toBe(7);
  });

  it('initiative_set.order contains every PC UUID and the spawned monster id', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);

    const spawn = result[0]!;
    const monsterId = (spawn.payload as { id: string }).id;

    const initiativeSet = result[1]!;
    expect(initiativeSet.type).toBe('initiative_set');
    const order = (initiativeSet.payload as { order: Array<{ actorId: string; initiative: number }> }).order;

    // All actorIds present
    const actorIds = order.map((e) => e.actorId);
    expect(actorIds).toContain(PC_UUID);
    expect(actorIds).toContain(monsterId);
  });

  it('initiative_set.order.length === party.length + 1 (two PCs)', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_TWO_PC, 'goblin', lookup);

    const initiativeSet = result[1]!;
    const order = (initiativeSet.payload as { order: unknown[] }).order;
    // 2 PCs + 1 monster
    expect(order.length).toBe(3);
  });

  it('the monster id used in monster_spawn matches the actorId in initiative_set', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);

    const monsterId = (result[0]!.payload as { id: string }).id;
    const order = (result[1]!.payload as { order: Array<{ actorId: string }> }).order;
    const found = order.some((e) => e.actorId === monsterId);
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Empty party → []
// ---------------------------------------------------------------------------

describe('runEncounterOpener — empty party', () => {
  it('returns [] (deep-equal) when snapshot.party is empty', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    expect(runEncounterOpener(SNAPSHOT_EMPTY_PARTY, 'goblin', lookup)).toEqual([]);
  });

  it('emits NO monster_spawn when party is empty', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_EMPTY_PARTY, 'goblin', lookup);
    expect(result.filter((e) => e.type === 'monster_spawn').length).toBe(0);
  });

  it('emits NO initiative_set when party is empty', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_EMPTY_PARTY, 'goblin', lookup);
    expect(result.filter((e) => e.type === 'initiative_set').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. REQ-047 invariant — no damage on the opener turn
// ---------------------------------------------------------------------------

describe('runEncounterOpener — REQ-047 no-damage invariant', () => {
  it('none of the events in the happy-path result has type "damage"', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);
    const damageEvents = result.filter((e) => e.type === 'damage');
    expect(damageEvents.length).toBe(0);
  });

  it('none of the events has type "monster_hp_change" (no HP delta on opener)', () => {
    const lookup = vi.fn().mockReturnValue(GOBLIN_STATS);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);
    const hpChangeEvents = result.filter((e) => e.type === 'monster_hp_change');
    expect(hpChangeEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Null bestiary fallback
// ---------------------------------------------------------------------------

describe('runEncounterOpener — null bestiary fallback', () => {
  it('does NOT throw when bestiaryLookup returns null', () => {
    const lookup = vi.fn().mockReturnValue(null);
    expect(() => runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup)).not.toThrow();
  });

  it('still emits a monster_spawn with a positive-integer hpMax when lookup is null', () => {
    const lookup = vi.fn().mockReturnValue(null);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const spawn = result.find((e) => e.type === 'monster_spawn');
    expect(spawn).toBeDefined();
    const hpMax = (spawn!.payload as { hpMax: number }).hpMax;
    expect(typeof hpMax).toBe('number');
    expect(Number.isInteger(hpMax)).toBe(true);
    expect(hpMax).toBeGreaterThan(0);
  });

  it('still emits an initiative_set when lookup is null', () => {
    const lookup = vi.fn().mockReturnValue(null);
    const result = runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);
    const initiativeSet = result.find((e) => e.type === 'initiative_set');
    expect(initiativeSet).toBeDefined();
  });

  it('does NOT throw when bestiaryLookup is called with the monster name', () => {
    const lookup = vi.fn().mockReturnValue(null);
    runEncounterOpener(SNAPSHOT_ONE_PC, 'goblin', lookup);
    expect(lookup).toHaveBeenCalledWith('goblin');
  });
});

// ---------------------------------------------------------------------------
// 5. extractMonsterName — author-prefix + article robustness (CR-01 / WR-01)
// ---------------------------------------------------------------------------

describe('extractMonsterName', () => {
  // Controls — these pass with the original heuristic and must keep passing.
  it('extracts the monster from a plain single-PC Italian message', () => {
    expect(extractMonsterName('attacco il goblin')).toBe('goblin');
  });

  it('extracts the monster from a plain single-PC Italian message (skeleton)', () => {
    expect(extractMonsterName('colpisci lo scheletro')).toBe('scheletro');
  });

  it('falls back to "Unknown Enemy" on an empty message (never throws)', () => {
    expect(extractMonsterName('')).toBe('Unknown Enemy');
  });

  // CR-01 — multi-PC sessions prefix history lines with `[CharName] `. The
  // extractor MUST ignore the speaker prefix and still return the monster,
  // NOT the PC's own bracketed name.
  it('ignores a leading [Author] speaker prefix (multi-PC) — Italian', () => {
    expect(extractMonsterName('[Aria] attacco il goblin')).toBe('goblin');
  });

  it('ignores a leading [Author] speaker prefix (multi-PC) — English', () => {
    expect(extractMonsterName('[Bryn] attack the goblin')).toBe('goblin');
  });

  // WR-01 — detectCombatIntent matches English verbs, so English articles
  // (the/a/an) must be stripped too, or the extractor returns the article.
  it('strips the English article "the"', () => {
    expect(extractMonsterName('attack the goblin')).toBe('goblin');
  });

  it('strips the English article "an"', () => {
    expect(extractMonsterName('strike an ogre')).toBe('ogre');
  });
});

describe('runEncounterOpener — initiative includes the PC DEX modifier (2026-06-10 audit)', () => {
  function scripted(faces: number[]): () => number {
    let i = 0;
    return () => faces[Math.min(i++, faces.length - 1)]!;
  }

  it('PC initiative = d20 + DEX mod (rules.md: initiative is a DEX check)', () => {
    const events = runEncounterOpener(
      { party: [{ id: 'pc-1', name: 'Nami', abilities: { DEX: 18 } }] }, // +4
      'goblin',
      () => ({ hpMax: 7, ac: 15, cr: '1/4' }),
      scripted([10, 10]), // PC d20=10 → 14; monster d20=10 → 10
    );
    const init = events.find((e) => e.type === 'initiative_set')!;
    const order = (init.payload as { order: { actorId: string; initiative: number }[] }).order;
    expect(order.find((o) => o.actorId === 'pc-1')!.initiative).toBe(14);
    expect(order[0]!.actorId).toBe('pc-1'); // 14 beats the monster's 10
  });

  it('negative DEX mod lowers initiative; missing abilities falls back to +0', () => {
    const events = runEncounterOpener(
      { party: [{ id: 'pc-neg', name: 'Tank', abilities: { DEX: 6 } }, { id: 'pc-plain', name: 'NoBlob' }] },
      'goblin',
      () => ({ hpMax: 7, ac: 15, cr: '1/4' }),
      scripted([10, 10, 11]), // pc-neg 10-2=8; pc-plain 10+0=10; monster 11
    );
    const init = events.find((e) => e.type === 'initiative_set')!;
    const order = (init.payload as { order: { actorId: string; initiative: number }[] }).order;
    expect(order.find((o) => o.actorId === 'pc-neg')!.initiative).toBe(8);
    expect(order.find((o) => o.actorId === 'pc-plain')!.initiative).toBe(10);
    expect(order[0]!.initiative).toBe(11); // monster first (D&D 5e: highest acts first)
  });
});
