import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import { resolveCombat, enforceResolvedNarration } from '@/app/api/sessions/[id]/turn/combat-resolver';
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

/**
 * TWO monsters sharing the exact name "Slime", and NEITHER is in turnOrder
 * (both orphaned) → genuinely ambiguous, no live participant to disambiguate to.
 */
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

/**
 * Dirty-but-live encounter mirroring the One Piece smoke (Phase 08 gap):
 * two monsters share the exact name "Veyra" — a STALE orphan spawn (`veyra`,
 * alive but NOT in turnOrder) and the LIVE boss (`veyra-1`, in turnOrder).
 * The resolver must disambiguate the name collision to the live participant.
 */
const DUP_NAME_STALE_ENCOUNTER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [
    { actorId: 'pc-uuid-1', initiative: 15 },
    { actorId: 'veyra-1', initiative: 12 },
  ],
  monsters: [
    // STALE orphan from an earlier aborted spawn — alive but NOT in turnOrder.
    { id: 'veyra', name: 'Veyra', hpCurrent: 12, hpMax: 12, ac: 14, isAlive: true, conditions: [] },
    // LIVE boss — the only "Veyra" in turnOrder.
    { id: 'veyra-1', name: 'Veyra', hpCurrent: 45, hpMax: 45, ac: 14, isAlive: true, conditions: [] },
  ],
};

/**
 * Genuinely ambiguous: two same-named monsters BOTH alive AND BOTH in turnOrder.
 * Disambiguation cannot pick one → resolver stays null (T-08-01 preserved).
 */
const DUP_NAME_BOTH_LIVE_ENCOUNTER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [
    { actorId: 'twin-1', initiative: 14 },
    { actorId: 'twin-2', initiative: 13 },
  ],
  monsters: [
    { id: 'twin-1', name: 'Veyra', hpCurrent: 20, hpMax: 20, ac: 14, isAlive: true, conditions: [] },
    { id: 'twin-2', name: 'Veyra', hpCurrent: 20, hpMax: 20, ac: 14, isAlive: true, conditions: [] },
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

// ---------------------------------------------------------------------------
// Duplicate-name disambiguation via turnOrder — Phase 08 operator-smoke gap.
// The LLM spawned two monsters named "Veyra" across sessions; name-only
// matching went ambiguous → resolver fell through on every roll → Phase-07
// loop. The resolver must disambiguate a name collision to the live combat
// participant (alive AND in turnOrder), staying null only if still ambiguous.
// ---------------------------------------------------------------------------

describe('resolveCombat — duplicate-name disambiguation via turnOrder', () => {
  it('to-hit: name collision → resolves to the live in-turnOrder monster (not the stale orphan)', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).',
      encounter: DUP_NAME_STALE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('to-hit');
    expect(result!.events).toEqual([]); // HIT (18 >= 14) → turn does not advance yet
    expect(result!.damageRequest).toMatch(/per danni a Veyra/);
  });

  it('damage: name collision → monster_hp_change targets the live in-turnOrder id (veyra-1)', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **9** for 1d6+3 (danni a Veyra) (6+3).',
      encounter: DUP_NAME_STALE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('damage');
    expect(result!.events).toEqual([
      { type: 'monster_hp_change', payload: { id: 'veyra-1', delta: -9 } },
      { type: 'turn_advance', payload: {} },
    ]);
  });

  it('to-hit: collision with BOTH live + in turnOrder → still null (T-08-01 ambiguity preserved)', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).',
      encounter: DUP_NAME_BOTH_LIVE_ENCOUNTER,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enforceResolvedNarration — server authority on resolution turns (Phase 08
// operator-smoke gap, 2026-05-30). The local model competes for the mechanical
// channel: it emits its OWN "Tira 2d6 danni …" request (which the old
// safety-net deferred to) and leaks apply_event JSON as text. On a resolution
// turn the resolver must be authoritative: strip both, enforce its request.
// ---------------------------------------------------------------------------

const HIT_RESULT = {
  kind: 'to-hit' as const,
  events: [],
  narrationDirective: '[RESOLVED BY SYSTEM: …]',
  damageRequest: 'Tira 1d6+3 per danni a Veyra',
};
const DAMAGE_RESULT = {
  // enforceResolvedNarration only reads `damageRequest`; events are irrelevant
  // here (the resolver's damage events are emitted by the route, not this helper).
  kind: 'damage' as const,
  events: [],
  narrationDirective: '[RESOLVED BY SYSTEM: …]',
  damageRequest: null,
};

describe('enforceResolvedNarration — server authority', () => {
  it('HIT: strips the model’s competing roll-request and enforces the resolver’s', () => {
    const llm = [
      'Il tuo pugno di energia si infila nell’ombra di Veyra.',
      '',
      '**"Tira 2d6+3 danni fisici."**',
    ].join('\n');
    const out = enforceResolvedNarration(llm, HIT_RESULT);
    expect(out).not.toMatch(/2d6/); // the model's malformed request is gone
    expect(out).toContain('Il tuo pugno di energia si infila'); // flavor kept
    expect(out).toContain('Tira 1d6+3 per danni a Veyra'); // resolver's request enforced
    expect((out.match(/\bTira\b/g) ?? []).length).toBe(1); // exactly one roll-request
  });

  it('DAMAGE turn: strips leaked apply_event JSON-as-text, appends nothing', () => {
    const llm = [
      'Il colpo si infila nel cuore dell’ombra, e il dolore si espande.',
      '',
      '**"monster_hp_change"**',
      '{"id":"veyra","delta":-12}',
      '',
      'Il suo corpo si contorce, l’ombra che si ritrae.',
      '',
      '**"turn_advance"**',
    ].join('\n');
    const out = enforceResolvedNarration(llm, DAMAGE_RESULT);
    expect(out).not.toMatch(/monster_hp_change|turn_advance/);
    expect(out).not.toMatch(/"delta"|\{.*\}/);
    expect(out).toContain('Il colpo si infila nel cuore');
    expect(out).toContain('Il suo corpo si contorce');
    expect(out).not.toMatch(/\bTira\b/); // no roll-request on a damage turn
  });

  it('strips a leaked combat_end label + JSON block', () => {
    const llm = 'Veyra non c’è più.\n\n**"combat_end"**\n{"type":"combat_end"}';
    const out = enforceResolvedNarration(llm, DAMAGE_RESULT);
    expect(out).toBe('Veyra non c’è più.');
  });

  it('keeps narrative prose that merely contains the word "Tira" (no dice formula)', () => {
    const out = enforceResolvedNarration('Tira un respiro profondo prima del colpo.', HIT_RESULT);
    expect(out).toContain('Tira un respiro profondo'); // narrative survives
    expect(out).toContain('Tira 1d6+3 per danni a Veyra'); // request still appended
  });

  it('idempotent: no duplicate if the model already surfaced the resolver’s exact request', () => {
    const llm = 'Colpito!\n\nTira 1d6+3 per danni a Veyra';
    const out = enforceResolvedNarration(llm, HIT_RESULT);
    expect((out.match(/Tira 1d6\+3 per danni a Veyra/g) ?? []).length).toBe(1);
  });
});
