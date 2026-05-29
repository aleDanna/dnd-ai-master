import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import { resolveCombat } from '@/app/api/sessions/[id]/turn/combat-resolver';
import { parseRollRequests } from '@/lib/roll-parser';

/**
 * Phase 08 Plan 01 — headless REQ-039 resolver-math unit suite (Wave 0 per
 * 08-VALIDATION.md). `resolveCombat` is a PURE function: no db mock, no tmpfs,
 * no scripted provider — just EncounterState fixtures + roll-result strings.
 *
 * Roll-result fixture strings are the EXECUTION-VERIFIED forms from
 * 08-RESEARCH § Code Examples (the exact output of `formatResultText`,
 * roll-request-button.tsx:125):
 *   "🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3)."  → 18 / nat 15 / +3
 *   "🎲 I rolled **18** for 1d20 (attaccare Veyra)."           → 18 / nat 18 / +0 (no breakdown)
 *   "🎲 I rolled **21** for 1d20+1 (attaccare Golem) (20+1)."  → nat 20
 */

// ---------------------------------------------------------------------------
// Fixtures — shape copied from tests/sessions/vault-combat-turn-interleaving.ts
// ---------------------------------------------------------------------------

/**
 * Active encounter with:
 *   - Veyra (ac 14)           — the standard hit/miss target.
 *   - Golem (ac 22)           — high AC, for nat-20-below-AC + crit cases.
 *   - Skeleton (NO ac)        — exercises the default-AC-12 path (D-08).
 */
const ACTIVE_ENCOUNTER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [
    { actorId: 'pc-uuid-1', initiative: 20 },
    { actorId: 'veyra-1', initiative: 12 },
  ],
  monsters: [
    { id: 'veyra-1', name: 'Veyra', hpCurrent: 30, hpMax: 30, ac: 14, isAlive: true, conditions: [] },
    { id: 'golem-1', name: 'Golem', hpCurrent: 50, hpMax: 50, ac: 22, isAlive: true, conditions: [] },
    { id: 'skel-1', name: 'Skeleton', hpCurrent: 13, hpMax: 13, isAlive: true, conditions: [] },
  ],
};

/** Encounter with TWO monsters sharing the exact name "Slime" → ambiguous. */
const AMBIGUOUS_ENCOUNTER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [{ actorId: 'pc-uuid-1', initiative: 20 }],
  monsters: [
    { id: 'slime-1', name: 'Slime', hpCurrent: 10, hpMax: 10, ac: 8, isAlive: true, conditions: [] },
    { id: 'slime-2', name: 'Slime', hpCurrent: 10, hpMax: 10, ac: 8, isAlive: true, conditions: [] },
  ],
};

// ---------------------------------------------------------------------------
// To-hit — hit vs miss vs AC
// ---------------------------------------------------------------------------

describe('resolveCombat — to-hit', () => {
  it('to-hit hit: total >= AC → kind to-hit, empty events, per-form damageRequest', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    // HIT does NOT advance the turn — it waits for the damage roll.
    expect(result!.events).toEqual([]);
    expect(result!.damageRequest).toMatch(/per danni a/);
    expect(result!.damageRequest).toContain('Veyra');
  });

  it('to-hit miss: total < AC → single turn_advance, damageRequest null', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **8** for 1d20+3 (attaccare Veyra) (5+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([{ type: 'turn_advance', payload: {} }]);
    expect(result!.damageRequest).toBeNull();
  });

  it('to-hit nat 20 below AC: still HIT (auto-hit) → damageRequest non-null', () => {
    // total 21 < Golem AC 22, but natural 20 → auto-hit.
    const result = resolveCombat({
      rollResult: '🎲 I rolled **21** for 1d20+1 (attaccare Golem) (20+1).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([]);
    expect(result!.damageRequest).not.toBeNull();
  });

  it('to-hit nat 1 at/above AC: still MISS (auto-miss) → damageRequest null', () => {
    // total 16 >= Veyra AC 14, but natural 1 → auto-miss.
    const result = resolveCombat({
      rollResult: '🎲 I rolled **16** for 1d20+15 (attaccare Veyra) (1+15).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([{ type: 'turn_advance', payload: {} }]);
    expect(result!.damageRequest).toBeNull();
  });

  it('to-hit +0 / no-breakdown: natural=total, nat-20-on-+0 auto-hits', () => {
    // "1d20 (attaccare Golem)." has NO breakdown → natural = total = 20 →
    // nat-20 auto-hit even though 20 < Golem AC 22.
    const result = resolveCombat({
      rollResult: '🎲 I rolled **20** for 1d20 (attaccare Golem).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([]);
    expect(result!.damageRequest).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Damage — HP delta + advance
// ---------------------------------------------------------------------------

describe('resolveCombat — damage', () => {
  it('damage roll: events = [monster_hp_change{id,-total}, turn_advance]', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **9** for 1d6+3 (danni a Veyra) (6+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('damage');
    expect(result!.events).toEqual([
      { type: 'monster_hp_change', payload: { id: 'veyra-1', delta: -9 } },
      { type: 'turn_advance', payload: {} },
    ]);
    expect(result!.damageRequest).toBeNull();
    // delta sign: a NEGATIVE delta equal to -total.
    const hp = result!.events[0]!;
    expect(hp.type).toBe('monster_hp_change');
    expect((hp.payload as { delta: number }).delta).toBe(-9);
  });

  it('damage target parsed case-insensitive from "danni a <name>"', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **5** for 1d6+2 (danni a vEyRa) (3+2).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('damage');
    expect((result!.events[0]!.payload as { id: string }).id).toBe('veyra-1');
  });
});

// ---------------------------------------------------------------------------
// Defaults — AC 12, die 1d6 (D-08)
// ---------------------------------------------------------------------------

describe('resolveCombat — defaults (D-08)', () => {
  it('default AC 12 when monster.ac absent: total 12 HITS the no-ac Skeleton', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **12** for 1d20+2 (attaccare Skeleton) (10+2).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([]); // HIT
    expect(result!.damageRequest).not.toBeNull();
  });

  it('default AC 12 when monster.ac absent: total 11 MISSES the no-ac Skeleton', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **11** for 1d20+1 (attaccare Skeleton) (10+1).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([{ type: 'turn_advance', payload: {} }]); // MISS
    expect(result!.damageRequest).toBeNull();
  });

  it('default die 1d6 appears in the damage request', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.damageRequest).toMatch(/1d6\+/);
  });
});

// ---------------------------------------------------------------------------
// Fall-through — null on unknown / ambiguous / wrong combo / garbage
// ---------------------------------------------------------------------------

describe('resolveCombat — fall-through (null)', () => {
  it('unknown target → null', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Goblin) (15+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).toBeNull();
  });

  it('ambiguous (>1 exact-name match) target → null', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Slime) (15+3).',
      encounter: AMBIGUOUS_ENCOUNTER,
    });
    expect(result).toBeNull();
  });

  it('1d20 during combat with NO attack keyword → null', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **15** for 1d20+2 (Percezione) (13+2).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).toBeNull();
  });

  it('non-d20 with no "danni" keyword → null', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **4** for 1d6 (qualcosa).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).toBeNull();
  });

  it('garbage string → null and does NOT throw', () => {
    expect(() =>
      resolveCombat({ rollResult: 'hello there', encounter: ACTIVE_ENCOUNTER }),
    ).not.toThrow();
    expect(resolveCombat({ rollResult: 'hello there', encounter: ACTIVE_ENCOUNTER })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-trip — the per-form damage request survives the client parser
// ---------------------------------------------------------------------------

describe('resolveCombat — damageRequest round-trip (RESEARCH Pitfall 1)', () => {
  it('parseRollRequests(result.damageRequest) carries the target name', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.damageRequest).not.toBeNull();

    const parsed = parseRollRequests(result!.damageRequest!);
    expect(parsed.length).toBeGreaterThan(0);
    // The `per danni a Veyra` lead-in makes extractPurpose capture the target
    // into the button label → the target name round-trips.
    expect(parsed[0]!.label).toContain('Veyra');
    expect(parsed[0]!.kind).toBe('damage');
  });
});
