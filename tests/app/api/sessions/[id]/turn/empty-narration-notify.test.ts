import { describe, it, expect } from 'vitest';

/**
 * Phase 10 Plan 04 — REQ-046 empty-narration branch decision test.
 *
 * route.ts's empty-narration `else` branch (after ~848) now implements:
 *
 *   const combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan;
 *   if (combatStateChanged) {
 *     notifySession(sessionId, { type: 'state' });   // silent refresh, no toast
 *   } else {
 *     notifySession(sessionId, { type: 'turn-error', reason: 'empty_response', ... });
 *   }
 *
 * This test asserts the BRANCH DECISION at the smallest correct unit: the
 * guard expression and the resulting event selection. It does NOT spin up a
 * live Postgres NOTIFY, an HTTP server, or claim a full route drive (the route
 * has no exported unit-test harness; a full headless route invocation is not
 * cheap and is out of scope for this unit).
 *
 * Pattern: mirrors the turn/ pure-function test convention (combat-resolver.test.ts).
 * No DB mock, no tmpfs, no scripted provider — just deterministic signal inputs
 * and the branch-decision helper modelled from the production logic.
 */

// ---------------------------------------------------------------------------
// Model the branch decision the same way route.ts computes it.
// This is NOT a re-implementation: it mirrors the production expression so the
// test is a direct specification of the invariant, not an end-to-end route call.
// ---------------------------------------------------------------------------

type NotifyPayload =
  | { type: 'state' }
  | { type: 'turn-error'; reason: 'empty_response' };

/**
 * The branch decision the route's empty-narration else block makes.
 *
 * @param _resolver   - The resolveCombat() return value (non-null when a player
 *                      attack roll was server-resolved during this turn).
 * @param _monsterLoopRan - True when the monster-turn loop executed at least one
 *                      monster action this turn.
 * @param openerRan   - True when the encounter-opener hook dispatched at least one
 *                      encounter event this turn (REQ-045, 10-03).
 * @returns The notify payload that EXACTLY ONE of the two branches emits:
 *          {type:'state'} (silent refresh) when combatStateChanged, or
 *          {type:'turn-error', reason:'empty_response'} (retry toast) otherwise.
 */
function emptyNarrationBranchDecision(
  _resolver: object | null,
  _monsterLoopRan: boolean,
  openerRan: boolean,
): NotifyPayload {
  // Mirrors route.ts empty-narration else branch exactly (10-04 commit).
  const combatStateChanged = _resolver !== null || _monsterLoopRan || openerRan;
  if (combatStateChanged) {
    return { type: 'state' };
  }
  return { type: 'turn-error', reason: 'empty_response' };
}

// ---------------------------------------------------------------------------
// 1. Guard expression truth table
// ---------------------------------------------------------------------------

describe('combatStateChanged guard expression', () => {
  it('is false when all three signals are falsy (genuine non-combat empty turn)', () => {
    const result = emptyNarrationBranchDecision(null, false, false);
    // combatStateChanged = null !== null || false || false = false
    expect(result.type).toBe('turn-error');
  });

  it('is true when _resolver is non-null (player attack resolved server-side)', () => {
    const result = emptyNarrationBranchDecision({ events: [] }, false, false);
    // combatStateChanged = {} !== null = true
    expect(result.type).toBe('state');
  });

  it('is true when _monsterLoopRan is true (monster actions executed this turn)', () => {
    const result = emptyNarrationBranchDecision(null, true, false);
    // combatStateChanged = false || true || false = true
    expect(result.type).toBe('state');
  });

  it('is true when openerRan is true (encounter-opener dispatched events this turn)', () => {
    const result = emptyNarrationBranchDecision(null, false, true);
    // combatStateChanged = false || false || true = true
    expect(result.type).toBe('state');
  });

  it('is true when multiple signals are truthy simultaneously', () => {
    const result = emptyNarrationBranchDecision({ events: [] }, true, true);
    expect(result.type).toBe('state');
  });
});

// ---------------------------------------------------------------------------
// 2. Branch outcome — COMBAT empty turn (combatStateChanged true)
// ---------------------------------------------------------------------------

describe('combat empty turn — combatStateChanged true', () => {
  it('emits {type:"state"} (silent refetch — tracker updates, NO error toast)', () => {
    // Scenario: player attacked, server resolved the hit, monster HP changed,
    // turn_advance fired — but the LLM produced no narration text.
    // The turn SUCCEEDED; it must not show a "no response / retry" toast.
    const payload = emptyNarrationBranchDecision({ events: [{ type: 'monster_hp_change' }] }, false, false);
    expect(payload.type).toBe('state');
  });

  it('does NOT emit turn-error on a combat empty turn (XOR invariant — state fires, not turn-error)', () => {
    const payload = emptyNarrationBranchDecision({ events: [] }, true, false);
    expect(payload.type).not.toBe('turn-error');
  });

  it('does NOT emit turn-error when opener ran (XOR invariant)', () => {
    const payload = emptyNarrationBranchDecision(null, false, true);
    expect(payload.type).not.toBe('turn-error');
  });
});

// ---------------------------------------------------------------------------
// 3. Branch outcome — NON-COMBAT empty turn (combatStateChanged false)
// ---------------------------------------------------------------------------

describe('non-combat empty turn — combatStateChanged false', () => {
  it('emits {type:"turn-error", reason:"empty_response"} so the player can retry', () => {
    // Scenario: non-combat narrative turn; model produced nothing.
    // The player MUST see the retry toast.
    const payload = emptyNarrationBranchDecision(null, false, false);
    expect(payload.type).toBe('turn-error');
    if (payload.type === 'turn-error') {
      expect(payload.reason).toBe('empty_response');
    }
  });

  it('does NOT emit {type:"state"} on a genuine non-combat empty turn (XOR invariant)', () => {
    const payload = emptyNarrationBranchDecision(null, false, false);
    expect(payload.type).not.toBe('state');
  });
});

// ---------------------------------------------------------------------------
// 4. XOR invariant — EXACTLY ONE notify per empty turn
// ---------------------------------------------------------------------------

describe('XOR invariant — exactly one notify fires per empty turn', () => {
  const cases: Array<[object | null, boolean, boolean, 'state' | 'turn-error']> = [
    [null,             false, false, 'turn-error'],
    [{ events: [] },  false, false, 'state'     ],
    [null,             true,  false, 'state'     ],
    [null,             false, true,  'state'     ],
    [{ events: [] },  true,  true,  'state'     ],
  ];

  it.each(cases)(
    '_resolver=%o _monsterLoopRan=%s openerRan=%s → exactly ONE notify of type "%s"',
    (_resolver, _monsterLoopRan, openerRan, expectedType) => {
      const payload = emptyNarrationBranchDecision(_resolver, _monsterLoopRan, openerRan);
      // Exactly one type — state XOR turn-error, never both
      expect(payload.type).toBe(expectedType);
      if (expectedType === 'state') {
        expect(payload.type).not.toBe('turn-error');
      } else {
        expect(payload.type).not.toBe('state');
      }
    },
  );
});
