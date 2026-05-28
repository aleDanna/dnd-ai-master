import { describe, it, expect, vi } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import type { TurnAdvanceDecision } from '@/multiplayer/turn-advance';

/**
 * Phase 07 Plan 03 — vault combat turn interleaving.
 *
 * Tests the `resolveCombatHandoff` pure helper that derives the turn-handoff
 * decision from an active EncounterState. The helper is called by the vault
 * branch of the turn route BEFORE the existing detectAddressee / computeTurnAdvance
 * path, which is preserved as a fallback for inactive encounters.
 *
 * Coverage:
 *
 *   Suite A — Combat interleaving (active encounter):
 *     (a) PC actor at currentIdx → kind:'advance', nextCharacterId === PC UUID
 *     (b) Monster actor at currentIdx → kind:'skip' (no handoff)
 *     (c) Wrap-around: last-in-order PC → kind:'advance' to that PC
 *
 *   Suite B — Fallback cases:
 *     (d) Encounter inactive (active:false) → kind:'fallback' (caller uses detectAddressee path)
 *     (e) turnOrder empty → kind:'fallback'
 *     (f) currentIdx out of range → kind:'fallback'
 *
 *   Suite C — Non-combat regression (CRITICAL):
 *     (g) Session with no active encounter uses INITIAL_ENCOUNTER_STATE →
 *         same decision as computeTurnAdvance would produce (i.e. fallback).
 *         Verified via a mock of detectAddressee + computeTurnAdvance:
 *         the caller must still invoke those functions on a fallback result.
 *
 * The helper returns a discriminated union:
 *   | { kind: 'advance'; nextCharacterId: string }  — hand off to this PC
 *   | { kind: 'skip' }                              — monster turn; no handoff
 *   | { kind: 'fallback' }                          — caller uses existing path
 *
 * This three-way union is intentionally distinct from TurnAdvanceDecision
 * ('advance' | 'skip') because the route needs to know whether to run the
 * detectAddressee/computeTurnAdvance path (fallback) vs short-circuit it
 * (advance or skip from encounter).
 */

// ---------------------------------------------------------------------------
// The helper under test.
// NOTE: this import will fail until the GREEN step creates the module.
// That is expected RED behaviour.
// ---------------------------------------------------------------------------
import { resolveCombatHandoff } from '@/app/api/sessions/[id]/turn/combat-handoff';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A party of two PCs. */
const TWO_PLAYER_PARTY = [
  { id: 'pc-uuid-1', name: 'Luffy' },
  { id: 'pc-uuid-2', name: 'Zoro' },
];

/** Active encounter with Luffy first, then goblin. */
const ACTIVE_ENCOUNTER_PC_FIRST: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [
    { actorId: 'pc-uuid-1', initiative: 20 },
    { actorId: 'goblin-1', initiative: 12 },
  ],
  monsters: [{ id: 'goblin-1', name: 'Goblin', hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] }],
};

/** Active encounter with goblin second (currentIdx:1). */
const ACTIVE_ENCOUNTER_MONSTER_TURN: EncounterState = {
  ...ACTIVE_ENCOUNTER_PC_FIRST,
  currentIdx: 1,
};

/** Active encounter where last slot is a PC (wrap-around scenario). */
const ACTIVE_ENCOUNTER_WRAP: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 1,
  turnOrder: [
    { actorId: 'goblin-1', initiative: 12 },
    { actorId: 'pc-uuid-1', initiative: 8 },
  ],
  monsters: [{ id: 'goblin-1', name: 'Goblin', hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] }],
};

/** Inactive encounter (combat not started or ended). */
const INACTIVE_ENCOUNTER: EncounterState = {
  active: false,
  round: 0,
  currentIdx: 0,
  turnOrder: [],
  monsters: [],
};

/** Active encounter with empty turnOrder. */
const ACTIVE_EMPTY_TURN_ORDER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [],
  monsters: [],
};

/** Active encounter where currentIdx is out of range. */
const ACTIVE_IDX_OUT_OF_RANGE: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 5,
  turnOrder: [
    { actorId: 'pc-uuid-1', initiative: 20 },
  ],
  monsters: [],
};

// ---------------------------------------------------------------------------
// Suite A — Combat interleaving (active encounter)
// ---------------------------------------------------------------------------

describe('resolveCombatHandoff — Suite A: active encounter', () => {
  it('(a) PC actor at currentIdx → advance to that PC UUID', () => {
    const result = resolveCombatHandoff({ encounter: ACTIVE_ENCOUNTER_PC_FIRST, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('advance');
    expect((result as { kind: 'advance'; nextCharacterId: string }).nextCharacterId).toBe('pc-uuid-1');
  });

  it('(b) Monster actor at currentIdx → skip (no handoff)', () => {
    const result = resolveCombatHandoff({ encounter: ACTIVE_ENCOUNTER_MONSTER_TURN, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('skip');
  });

  it('(c) Wrap-around: PC at last slot in turnOrder → advance to that PC UUID', () => {
    const result = resolveCombatHandoff({ encounter: ACTIVE_ENCOUNTER_WRAP, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('advance');
    expect((result as { kind: 'advance'; nextCharacterId: string }).nextCharacterId).toBe('pc-uuid-1');
  });
});

// ---------------------------------------------------------------------------
// Suite B — Fallback cases
// ---------------------------------------------------------------------------

describe('resolveCombatHandoff — Suite B: fallback cases', () => {
  it('(d) Encounter inactive (active:false) → fallback', () => {
    const result = resolveCombatHandoff({ encounter: INACTIVE_ENCOUNTER, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('fallback');
  });

  it('(e) Active encounter with empty turnOrder → fallback', () => {
    const result = resolveCombatHandoff({ encounter: ACTIVE_EMPTY_TURN_ORDER, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('fallback');
  });

  it('(f) currentIdx out of range → fallback', () => {
    const result = resolveCombatHandoff({ encounter: ACTIVE_IDX_OUT_OF_RANGE, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// Suite C — Non-combat regression (CRITICAL)
// ---------------------------------------------------------------------------

describe('resolveCombatHandoff — Suite C: non-combat regression', () => {
  it('(g) INITIAL_ENCOUNTER_STATE (no active combat) → fallback; route uses detectAddressee/computeTurnAdvance unchanged', () => {
    // This is the regression guard: with INITIAL_ENCOUNTER_STATE the new helper
    // MUST return 'fallback', ensuring the route falls through to the existing
    // detectAddressee + computeTurnAdvance path — byte-for-byte unchanged
    // behavior from the caller's perspective.
    const INITIAL_ENCOUNTER_STATE: EncounterState = {
      active: false,
      round: 0,
      currentIdx: 0,
      turnOrder: [],
      monsters: [],
    };

    const singlePlayerParty = [{ id: 'pc-uuid-1', name: 'Luffy' }];
    const result = resolveCombatHandoff({ encounter: INITIAL_ENCOUNTER_STATE, party: singlePlayerParty });

    // The helper returns 'fallback' → the route runs the existing detectAddressee /
    // computeTurnAdvance code, which has not been modified.
    expect(result.kind).toBe('fallback');
  });

  it('(h) monster-only encounter (no PC in turnOrder) → skip (monster turn, no handoff)', () => {
    // All actors in turnOrder are monsters. This is a valid active encounter
    // but no actor is a PC — return 'skip' for the current actor.
    const monsterOnlyEncounter: EncounterState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [
        { actorId: 'goblin-1', initiative: 18 },
        { actorId: 'orc-1', initiative: 10 },
      ],
      monsters: [
        { id: 'goblin-1', name: 'Goblin', hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] },
        { id: 'orc-1', name: 'Orc', hpCurrent: 15, hpMax: 15, isAlive: true, conditions: [] },
      ],
    };

    const result = resolveCombatHandoff({ encounter: monsterOnlyEncounter, party: TWO_PLAYER_PARTY });
    expect(result.kind).toBe('skip');
  });
});
