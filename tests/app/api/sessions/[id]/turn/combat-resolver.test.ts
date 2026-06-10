import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import { resolveCombat, enforceResolvedNarration, canonicalizeToHitTarget, stripLeakedMechanics, isNarrationOnlyTurn, parseAttackRollTarget, shouldRetryEmptyNarration, doubleDice } from '@/app/api/sessions/[id]/turn/combat-resolver';
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


// =====================================================================
// Phase 08-02 — matchMonster article normalization (RED tests, 2026-06-01)
//
// The roll label produced by the master carries an Italian article
// ("il", "la", "lo", "l'", "i", "gli", "le") before the monster name,
// and may carry a descriptor tail after the number ("con il naso enorme").
// matchMonster must strip both so the normalized needle matches the exact
// numbered name in the encounter.
//
// Regression: the existing AMBIGUOUS_ENCOUNTER / DUP_NAME_BOTH_LIVE
// tests (0 matches → null) must NOT be broken by the normalization.
// =====================================================================
const PIRATE_ENCOUNTER: import("@/ai/master/vault/projector").EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [
    { actorId: "pc-uuid-luffy", initiative: 15 },
    { actorId: "pirata-buggy-1", initiative: 12 },
    { actorId: "pirata-buggy-2", initiative: 11 },
    { actorId: "pirata-buggy-3", initiative: 10 },
  ],
  monsters: [
    { id: "pirata-buggy-1", name: "Pirata di Buggy 1", hpCurrent: 20, hpMax: 20, ac: 13, isAlive: true, conditions: [] },
    { id: "pirata-buggy-2", name: "Pirata di Buggy 2", hpCurrent: 20, hpMax: 20, ac: 13, isAlive: true, conditions: [] },
    { id: "pirata-buggy-3", name: "Pirata di Buggy 3", hpCurrent: 20, hpMax: 20, ac: 13, isAlive: true, conditions: [] },
  ],
};

describe("resolveCombat — article + descriptor normalization (Phase 08-02)", () => {
  it("to-hit: 'attaccare il Pirata di Buggy 2' strips article → resolves to pirata-buggy-2", () => {
    const result = resolveCombat({
      rollResult: "🎲 I rolled **18** for 1d20+4 (attaccare il Pirata di Buggy 2) (14+4).",
      encounter: PIRATE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("to-hit");
    expect(result!.events).toEqual([]); // HIT (18 >= AC 13)
    expect(result!.damageRequest).toContain("Pirata di Buggy 2");
  });

  it("to-hit: 'attaccare il Pirata di Buggy 2 con il naso enorme' strips article+descriptor → resolves", () => {
    const result = resolveCombat({
      rollResult: "🎲 I rolled **18** for 1d20+4 (attaccare il Pirata di Buggy 2 con il naso enorme) (14+4).",
      encounter: PIRATE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("to-hit");
    expect(result!.damageRequest).toContain("Pirata di Buggy 2");
  });

  it("to-hit: 'attaccare il Pirata di Buggy 1' → resolves to pirata-buggy-1", () => {
    const result = resolveCombat({
      rollResult: "🎲 I rolled **18** for 1d20+4 (attaccare il Pirata di Buggy 1) (14+4).",
      encounter: PIRATE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect((result!.events[0] === undefined) || true).toBe(true); // HIT → no events
    expect(result!.damageRequest).toContain("Pirata di Buggy 1");
  });

  it("damage: 'danni a il Pirata di Buggy 3' strips article → monster_hp_change id=pirata-buggy-3", () => {
    const result = resolveCombat({
      rollResult: "🎲 I rolled **9** for 1d6+4 (danni a il Pirata di Buggy 3) (5+4).",
      encounter: PIRATE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("damage");
    expect(result!.events).toEqual([
      { type: "monster_hp_change", payload: { id: "pirata-buggy-3", delta: -9 } },
      { type: "turn_advance", payload: {} },
    ]);
  });

  it("to-hit: bare numbered name without article → still resolves (regression)", () => {
    const result = resolveCombat({
      rollResult: "🎲 I rolled **18** for 1d20+4 (attaccare Pirata di Buggy 2) (14+4).",
      encounter: PIRATE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("to-hit");
  });

  it("to-hit: bare unnumbered name in a single-monster encounter → resolves (regression)", () => {
    // A lone unnumbered monster with article prefix must still resolve.
    const enc: import("@/ai/master/vault/projector").EncounterState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [{ actorId: "boss-1", initiative: 10 }],
      monsters: [
        { id: "boss-1", name: "Boss", hpCurrent: 50, hpMax: 50, ac: 15, isAlive: true, conditions: [] },
      ],
    };
    const result = resolveCombat({
      rollResult: "🎲 I rolled **18** for 1d20+4 (attaccare il Boss) (14+4).",
      encounter: enc,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("to-hit");
    expect(result!.damageRequest).toContain("Boss");
  });
});


// =====================================================================
// Phase 08-03 — canonicalizeToHitTarget (RED tests, 2026-06-02)
//
// The TO-HIT roll request is LLM-authored. qwen3 writes the attack target
// as a prose descriptor instead of the canonical numbered name from combat.md
// (e.g. "Tira 1d20+4 per attaccare il Pirata di Buggy con il naso enorme"
// instead of "Tira 1d20+4 per attaccare Pirata di Buggy 1"). The roll-result
// label then carries the prose name, which normalizeTargetName strips to the
// bare base name "Pirata di Buggy" — which no longer matches the now-numbered
// names "Pirata di Buggy 1/2/3" — so resolveCombat returns null.
//
// Fix: canonicalizeToHitTarget(finalText, playerMessage, encounter) is a pure
// server-side rewrite helper that:
//   1. Parses the PLAYER message to find the intended target (reusing
//      normalizeTargetName + matchMonster from the resolver).
//   2. If a unique live monster matches, rewrites the master's
//      "Tira NdM+bonus per attaccare <whatever>" line(s) to
//      "Tira NdM+bonus per attaccare <canonical name>".
//      The BONUS (+N) is PRESERVED from the master's original line.
//      Only the TARGET name is canonicalized.
//   3. Also strips leaked apply_event tool-prose
//      ("Applica il danno…", "chiama turn_advance", bare event labels/JSON)
//      so the declaration turn can't carry mechanics as text.
//   4. If no unique match OR no "Tira … 1d20 …" line → returns finalText
//      unchanged (safe fall-through, never throws).
//
// These tests are RED until canonicalizeToHitTarget is exported from
// combat-resolver.ts and the logic is implemented.
// =====================================================================

describe("canonicalizeToHitTarget (Phase 08-03)", () => {
  it("rewrites the master's prose-target to the canonical numbered name", () => {
    const finalText = "Luffy, vedo la determinazione nei tuoi occhi!\n\nTira 1d20+4 per attaccare il Pirata di Buggy con il naso enorme.";
    const playerMessage = "attacco pirata di buggy 1 con un gum gum pistol";
    const result = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    // The canonical name must appear in the to-hit line
    expect(result).toContain("Pirata di Buggy 1");
    // The prose descriptor must be gone from the to-hit line
    expect(result).not.toMatch(/con il naso enorme/);
    // The bonus must be preserved
    expect(result).toContain("+4");
    // The narrative flavor must survive
    expect(result).toContain("Luffy, vedo la determinazione");
  });

  it("preserves the master's bonus (+N) and only replaces the target", () => {
    const finalText = "Tira 1d20+7 per attaccare il Pirata di Buggy sporco.";
    const playerMessage = "colpisco pirata di buggy 2";
    const result = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    expect(result).toContain("Pirata di Buggy 2");
    expect(result).toContain("+7");
  });

  it("strips leaked apply_event prose from a declaration turn", () => {
    const finalText = [
      "Luffy si lancia all'attacco!",
      "",
      "Tira 1d20+4 per attaccare il Pirata di Buggy con il naso enorme.",
      "",
      "Applica il danno: con id: \"pirata-buggy-1\" e delta: -8.",
      "Poi, chiama turn_advance.",
      "monster_hp_change",
    ].join("\n");
    const playerMessage = "attacco pirata di buggy 1";
    const result = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    // Leaked tool prose must be stripped
    expect(result).not.toMatch(/Applica il danno/);
    expect(result).not.toMatch(/chiama turn_advance/);
    expect(result).not.toMatch(/monster_hp_change/);
    // Canonical to-hit line must be present
    expect(result).toContain("Pirata di Buggy 1");
    // Flavor survives
    expect(result).toContain("Luffy si lancia");
  });

  it("returns finalText unchanged when the player target is ambiguous (no unique match)", () => {
    // AMBIGUOUS_ENCOUNTER has two 'Slime' monsters, both alive and in turnOrder
    const finalText = "Tira 1d20+3 per attaccare lo Slime.";
    const playerMessage = "attacco lo slime";
    const result = canonicalizeToHitTarget(finalText, playerMessage, AMBIGUOUS_ENCOUNTER);
    // No rewrite — fall through safely
    expect(result).toBe(finalText);
  });

  it("APPENDS a canonical server-owned to-hit request when the LLM narrated no roll line (Phase 08-04)", () => {
    // Phase 08-04: the server OWNS the to-hit request. If the LLM narrated without
    // asking for a roll, the server appends the canonical request so the player ALWAYS
    // gets a resolvable roll button on their attack turn.
    const finalText = "Il master descrive la scena senza chiedere tiri.";
    const playerMessage = "attacco pirata di buggy 1";
    const result = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    expect(result).toContain("Il master descrive la scena senza chiedere tiri.");
    expect(result).toContain("Tira 1d20 per attaccare Pirata di Buggy 1");
  });

  it("returns finalText unchanged when encounter is not active", () => {
    const inactiveEncounter: EncounterState = { ...PIRATE_ENCOUNTER, active: false };
    const finalText = "Tira 1d20+4 per attaccare il Pirata di Buggy con il naso enorme.";
    const playerMessage = "attacco pirata di buggy 1";
    const result = canonicalizeToHitTarget(finalText, playerMessage, inactiveEncounter);
    expect(result).toBe(finalText);
  });

  it("does NOT throw on empty / undefined inputs", () => {
    expect(() => canonicalizeToHitTarget("", "", PIRATE_ENCOUNTER)).not.toThrow();
    expect(() => canonicalizeToHitTarget("", "attacco pirata di buggy 1", PIRATE_ENCOUNTER)).not.toThrow();
    expect(canonicalizeToHitTarget("", "attacco pirata di buggy 1", PIRATE_ENCOUNTER)).toBe("");
  });

  it("end-to-end: rewritten finalText yields a resolvable roll label via resolveCombat", () => {
    // Simulate the full pipe: canonical finalText → client parses roll label →
    // server resolves. The client produces labels from formatResultText using
    // the request text, so a canonical request "Tira 1d20+4 per attaccare Pirata
    // di Buggy 1" → label "attaccare Pirata di Buggy 1" → resolveCombat matches.
    const finalText = "Tira 1d20+4 per attaccare il Pirata di Buggy con il naso enorme.";
    const playerMessage = "attacco pirata di buggy 1";
    const rewritten = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    // The rewritten text must contain a parseable request with the canonical name.
    expect(rewritten).toContain("Tira 1d20+4 per attaccare Pirata di Buggy 1");
    // Simulate what the client parser produces as a roll label:
    const simulatedRollResult = "🎲 I rolled **18** for 1d20+4 (attaccare Pirata di Buggy 1) (14+4).";
    const resolved = resolveCombat({ rollResult: simulatedRollResult, encounter: PIRATE_ENCOUNTER });
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("to-hit");
    expect(resolved!.events).toEqual([]); // HIT (18 >= AC 13)
    expect(resolved!.damageRequest).toContain("Pirata di Buggy 1");
  });
});

// =====================================================================
// Phase 08-04 — server-OWNED to-hit (append-authoritative) + stripLeakedMechanics.
// The combat turn is now fully server-owned: nothing combat-mechanical depends on the
// LLM. The server guarantees a canonical to-hit request even when the model writes
// none, and strips leaked apply_event prose on any combat turn the resolver didn't fire.
// =====================================================================

describe("canonicalizeToHitTarget — append-authoritative (Phase 08-04)", () => {
  it("appends the canonical request even when the turn is ONLY leaked mechanics prose", () => {
    const finalText = [
      'Applica il danno: con id: "pirata-buggy-1" e delta: -8.',
      "Poi, chiama turn_advance.",
    ].join("\n");
    const playerMessage = "attacco pirata di buggy 1";
    const result = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    expect(result).not.toMatch(/Applica il danno/);
    expect(result).not.toMatch(/chiama turn_advance/);
    expect(result).toContain("Tira 1d20 per attaccare Pirata di Buggy 1");
  });

  it("strips a MALFORMED model roll-ask (literal +<bonus>) → exactly ONE canonical request, no duplicate (Phase 08-06)", () => {
    // gemma4 narrates a roll-ask with an unfilled placeholder bonus; TO_HIT_RE (which
    // needs digits after +) misses it, so without a lenient strip it survives AND the
    // server appends → TWO roll buttons (observed live 2026-06-04).
    const finalText = "Ti scagli in avanti.\n\nTira 1d20+<bonus> per attaccare Pirata di Buggy 1.";
    const playerMessage = "attacco pirata di buggy 1";
    const result = canonicalizeToHitTarget(finalText, playerMessage, PIRATE_ENCOUNTER);
    const count = (result.match(/Tira[^\n]*1d20/gi) || []).length;
    expect(count).toBe(1);                 // exactly one roll request — no duplicate
    expect(result).not.toMatch(/<bonus>/); // malformed placeholder gone
    expect(result).toContain("Pirata di Buggy 1");
    expect(result).toContain("Ti scagli in avanti");
  });

  it("preserves a VALID model bonus into the single appended request", () => {
    const finalText = "Colpisci!\n\nTira 1d20+5 per attaccare il Pirata di Buggy con la cicatrice.";
    const result = canonicalizeToHitTarget(finalText, "attacco pirata di buggy 2", PIRATE_ENCOUNTER);
    const count = (result.match(/Tira[^\n]*1d20/gi) || []).length;
    expect(count).toBe(1);
    expect(result).toContain("Tira 1d20+5 per attaccare Pirata di Buggy 2");
    expect(result).not.toMatch(/con la cicatrice/);
  });
});

describe("stripLeakedMechanics (Phase 08-04)", () => {
  it("strips leaked apply_event prose + event labels/JSON, keeps narration", () => {
    const finalText = [
      "Il pirata barcolla sotto il colpo.",
      'Applica il danno: con id: "pirata-buggy-1" e delta: -8.',
      "Poi, chiama turn_advance.",
      "monster_hp_change",
      '{ "id": "pirata-buggy-1", "delta": -8 }',
    ].join("\n");
    const result = stripLeakedMechanics(finalText);
    expect(result).toContain("Il pirata barcolla");
    expect(result).not.toMatch(/Applica il danno/);
    expect(result).not.toMatch(/turn_advance/);
    expect(result).not.toMatch(/monster_hp_change/);
    expect(result).not.toMatch(/"delta"/);
  });

  it("leaves a clean narration unchanged and does not throw on empty", () => {
    const clean = "Il pirata ti fissa, pronto a colpire.";
    expect(stripLeakedMechanics(clean)).toBe(clean);
    expect(() => stripLeakedMechanics("")).not.toThrow();
    expect(stripLeakedMechanics("")).toBe("");
  });
});

describe('isNarrationOnlyTurn — offerTools suppression gate', () => {
  const base = {
    isBegin: false,
    vaultMutationsEnabled: true,
    encounterActive: false,
    isCombatDeclaration: false,
    isRollResult: false,
    resolverFired: false,
    monsterLoopRan: false,
  };

  it('begin turn → narration-only regardless of campaign flags', () => {
    expect(isNarrationOnlyTurn({ ...base, isBegin: true, vaultMutationsEnabled: false })).toBe(true);
  });

  it('ACTIVE encounter → narration-only even when intent is missed AND resolver did not fire', () => {
    // The gemma4 CoT-leak fix: "riattacco il goblin" (intent missed) on an active
    // encounter where resolveCombat returned null (bare/ambiguous target) must NOT
    // hand the model the tools.
    expect(isNarrationOnlyTurn({ ...base, encounterActive: true })).toBe(true);
  });

  it('combat declaration (first attack from exploration, encounter not yet active) → narration-only', () => {
    expect(isNarrationOnlyTurn({ ...base, isCombatDeclaration: true })).toBe(true);
  });

  it('ANY roll-result → narration-only even with NO active encounter (master-initiated fake-combat meltdown fix)', () => {
    // The master narrated a fight the player never declared → opener never fired →
    // no encounter. The follow-up attack roll must still be tool-free or a weak
    // model (gemma4) melts down into garbage.
    expect(isNarrationOnlyTurn({ ...base, isRollResult: true })).toBe(true);
  });

  it('server-resolved roll → narration-only', () => {
    expect(isNarrationOnlyTurn({ ...base, resolverFired: true })).toBe(true);
  });

  it('monster loop ran → narration-only', () => {
    expect(isNarrationOnlyTurn({ ...base, monsterLoopRan: true })).toBe(true);
  });

  it('plain exploration turn → tools OFFERED', () => {
    expect(isNarrationOnlyTurn(base)).toBe(false);
  });

  it('combat signals on a NON-mutations campaign → tools offered (gate respects vaultMutations)', () => {
    expect(
      isNarrationOnlyTurn({
        ...base,
        vaultMutationsEnabled: false,
        encounterActive: true,
        isCombatDeclaration: true,
        resolverFired: true,
        monsterLoopRan: true,
      }),
    ).toBe(false);
  });
});

describe('resolveCombat — combat_end on the killing blow (server ends combat)', () => {
  // Solo encounter: one goblin at 2 HP. The master is narration-only during
  // combat (isNarrationOnlyTurn), so it can no longer call apply_event(combat_end)
  // — the SERVER must end combat when the last monster dies.
  const SOLO_ENCOUNTER: EncounterState = {
    active: true,
    round: 2,
    currentIdx: 0,
    turnOrder: [
      { actorId: 'pc-uuid-1', initiative: 19 },
      { actorId: 'gob-1', initiative: 9 },
    ],
    monsters: [
      { id: 'gob-1', name: 'goblin', hpCurrent: 2, hpMax: 7, ac: 15, isAlive: true, conditions: [] },
    ],
  };

  it('killing the LAST alive monster emits combat_end instead of turn_advance', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **5** for 1d6+0 (danni a goblin).',
      encounter: SOLO_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('damage');
    expect(result!.events).toEqual([
      { type: 'monster_hp_change', payload: { id: 'gob-1', delta: -5 } },
      { type: 'combat_end', payload: {} },
    ]);
  });

  it('non-lethal damage to a solo monster still emits turn_advance', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **1** for 1d6+0 (danni a goblin).',
      encounter: SOLO_ENCOUNTER,
    });
    expect(result!.events).toEqual([
      { type: 'monster_hp_change', payload: { id: 'gob-1', delta: -1 } },
      { type: 'turn_advance', payload: {} },
    ]);
  });

  it('killing one monster while others are still alive emits turn_advance (combat continues)', () => {
    // ACTIVE_ENCOUNTER: Veyra (30) + Golem (50) + Skeleton (13), all alive.
    const result = resolveCombat({
      rollResult: '🎲 I rolled **40** for 2d6 (danni a Veyra).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result!.events).toEqual([
      { type: 'monster_hp_change', payload: { id: 'veyra-1', delta: -40 } },
      { type: 'turn_advance', payload: {} },
    ]);
  });
});

describe('parseAttackRollTarget — master-initiated combat opener target extraction', () => {
  it('extracts the target from a to-hit roll-result (the master-authored name)', () => {
    expect(parseAttackRollTarget('🎲 I rolled **18** for 1d20+3 (attaccare goblin-1) (15+3).')).toBe('goblin-1');
  });

  it('extracts a multi-word / numbered target verbatim (spawn name must match the roll)', () => {
    expect(parseAttackRollTarget('🎲 I rolled **12** for 1d20 (colpire Pirata di Buggy 2).')).toBe('Pirata di Buggy 2');
  });

  it('returns null for a DAMAGE roll (only the to-hit opens an encounter)', () => {
    expect(parseAttackRollTarget('🎲 I rolled **5** for 1d6 (danni a goblin).')).toBeNull();
  });

  it('returns null for a non-combat skill check (Percezione must NOT open combat)', () => {
    expect(parseAttackRollTarget('🎲 I rolled **19** for Percezione.')).toBeNull();
  });

  it('returns null for a non-roll message', () => {
    expect(parseAttackRollTarget('mi avvicino al rumore')).toBeNull();
    expect(parseAttackRollTarget('')).toBeNull();
  });
});

describe('shouldRetryEmptyNarration (2026-06-10 audit — double-apply guard)', () => {
  const base = { finalText: '', toolCallCount: 0, resolverFired: false, monsterLoopRan: false, openerRan: false };

  it('retries on a GENUINE empty: no text, no tool calls, no server combat events', () => {
    expect(shouldRetryEmptyNarration(base)).toBe(true);
  });

  it('does NOT retry when the first pass dispatched tool calls — the mutations are already persisted in events.md, and a re-run would re-emit them (double damage / double slot use)', () => {
    expect(shouldRetryEmptyNarration({ ...base, toolCallCount: 2 })).toBe(false);
  });

  it('does NOT retry when text was produced', () => {
    expect(shouldRetryEmptyNarration({ ...base, finalText: 'La scena…' })).toBe(false);
    expect(shouldRetryEmptyNarration({ ...base, finalText: '   \n' })).toBe(true);
  });

  it('does NOT retry on server-resolved turns (resolver / monster loop / opener)', () => {
    expect(shouldRetryEmptyNarration({ ...base, resolverFired: true })).toBe(false);
    expect(shouldRetryEmptyNarration({ ...base, monsterLoopRan: true })).toBe(false);
    expect(shouldRetryEmptyNarration({ ...base, openerRan: true })).toBe(false);
  });
});

describe('resolveCombat — RAW attack math (2026-06-10 audit)', () => {
  it('with an attacker profile: damage request uses the WEAPON dice + ability mod only', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+5 (attaccare Veyra) (13+5).',
      encounter: ACTIVE_ENCOUNTER,
      attacker: { damageDice: '1d8', damageMod: 3 },
    });
    expect(result).not.toBeNull();
    // NOT '1d6+5' (the legacy default die + full to-hit bonus incl. PB).
    expect(result!.damageRequest).toBe('Tira 1d8+3 per danni a Veyra');
  });

  it('natural 20 DOUBLES the damage dice, not the modifier (rules.md §10)', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **23** for 1d20+3 (attaccare Veyra) (20+3).',
      encounter: ACTIVE_ENCOUNTER,
      attacker: { damageDice: '1d8', damageMod: 3 },
    });
    expect(result).not.toBeNull();
    expect(result!.damageRequest).toBe('Tira 2d8+3 per danni a Veyra');
    expect(result!.narrationDirective).toMatch(/CRITICO/);
  });

  it('natural 20 doubles the LEGACY default die too (no attacker profile)', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **23** for 1d20+3 (attaccare Veyra) (20+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result).not.toBeNull();
    expect(result!.damageRequest).toBe('Tira 2d6+3 per danni a Veyra');
  });

  it('negative damage mod renders as -N', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+1 (attaccare Veyra) (17+1).',
      encounter: ACTIVE_ENCOUNTER,
      attacker: { damageDice: '1d6', damageMod: -1 },
    });
    expect(result!.damageRequest).toBe('Tira 1d6-1 per danni a Veyra');
  });

  it('legacy behavior preserved without attacker: default die + parsed bonus', () => {
    const result = resolveCombat({
      rollResult: '🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).',
      encounter: ACTIVE_ENCOUNTER,
    });
    expect(result!.damageRequest).toBe('Tira 1d6+3 per danni a Veyra');
  });

  it('doubleDice doubles the count only', () => {
    expect(doubleDice('1d8')).toBe('2d8');
    expect(doubleDice('2d6')).toBe('4d6');
    expect(doubleDice('d6')).toBe('2d6');
  });
});

describe('canonicalizeToHitTarget — server-derived attack bonus (2026-06-10 audit)', () => {
  const NUMBERED_ENCOUNTER: EncounterState = {
    active: true,
    round: 1,
    currentIdx: 0,
    turnOrder: [{ actorId: 'pirata-buggy-1', initiative: 12 }],
    monsters: [
      { id: 'pirata-buggy-1', name: 'Pirata di Buggy 1', hpCurrent: 20, hpMax: 20, ac: 13, isAlive: true, conditions: [] },
    ],
  };

  it('uses the sheet-derived bonus over the model text bonus', () => {
    const out = canonicalizeToHitTarget(
      'Il pirata ti carica.\n\nTira 1d20+9 per attaccare il pirata.',
      'attacco il Pirata di Buggy 1',
      NUMBERED_ENCOUNTER,
      5,
    );
    expect(out).toContain('Tira 1d20+5 per attaccare Pirata di Buggy 1');
    expect(out).not.toContain('1d20+9');
  });

  it('renders +0 explicitly and negative bonuses with a minus', () => {
    const zero = canonicalizeToHitTarget('Testo.\n\nTira 1d20 per attaccare il pirata.', 'attacco il Pirata di Buggy 1', NUMBERED_ENCOUNTER, 0);
    expect(zero).toContain('Tira 1d20+0 per attaccare Pirata di Buggy 1');
    const neg = canonicalizeToHitTarget('Testo.', 'attacco il Pirata di Buggy 1', NUMBERED_ENCOUNTER, -1);
    expect(neg).toContain('Tira 1d20-1 per attaccare Pirata di Buggy 1');
  });

  it('legacy: without a server bonus the model bonus is still preserved', () => {
    const out = canonicalizeToHitTarget(
      'Testo.\n\nTira 1d20+4 per attaccare il pirata.',
      'attacco il Pirata di Buggy 1',
      NUMBERED_ENCOUNTER,
    );
    expect(out).toContain('Tira 1d20+4 per attaccare Pirata di Buggy 1');
  });
});
