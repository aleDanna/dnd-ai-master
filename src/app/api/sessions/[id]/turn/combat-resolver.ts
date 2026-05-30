/**
 * Phase 08 Plan 01 — server-side player-attack combat resolver (REQ-039).
 *
 * Pure function that turns the player's roll-result message + the active
 * EncounterState into a deterministic combat outcome WITHOUT reading the
 * filesystem, the clock, or any randomness. It mirrors the engine hit rule
 * (`attack.ts:345/361/365`) on the ALREADY-rolled d20 total — it does NOT
 * re-roll or call `makeAttack`/`applyDamage` (those re-roll the d20 and need a
 * full Character/resistance model the vault path lacks, D-09).
 *
 * The route emits the returned `events` server-side via the existing vault
 * dispatcher; the LLM then narrates the outcome (narration-only). The resolver
 * itself stays pure so it is headless-testable.
 *
 * Threat model (Phase 08 §STRIDE):
 *   - T-08-01 (Tampering): the target is matched by NAME (case-insensitive
 *     EXACT) against `encounter.monsters[].name`; the server-side `id`/`ac` are
 *     resolved from that single match. The player can NAME a monster but can
 *     NEVER inject an arbitrary `id`; 0 or >1 name matches → `null`.
 *   - T-08-02 (Tampering/DoS): the resolver only emits the `delta`; the HP
 *     clamp `max(0, hp+delta)` lives in the `monster_hp_change` reducer
 *     (`projector.ts:786`) — a hostile huge total bottoms HP at 0, never
 *     negative/overflow. HP clamping is NOT this function's job.
 *   - T-08-03 (DoS): the contract is NEVER throw → return `null` on any
 *     unparseable / ambiguous / non-combat input (D-05/D-10).
 *
 * Determinism: no clock reads, no env reads, no randomness. Pure function.
 */
import type { EncounterState } from '@/ai/master/vault/projector';
import type { VaultEvent } from '@/ai/master/vault/events-schema';

/** D-08 defaults — monster AC absent → 12; damage die default → "1d6". */
const DEFAULT_MONSTER_AC = 12;
const DEFAULT_DAMAGE_DIE = '1d6';

/**
 * The D-02 resolver return contract.
 *
 *   - `kind`              — `'to-hit'` (attack roll resolved vs AC) or
 *                           `'damage'` (damage roll applied to a monster). The
 *                           `'none'` arm exists for forward-compat with the
 *                           D-02 type; the function returns `null` (not a
 *                           `'none'` result) for every fall-through today.
 *   - `events`            — plain `{type,payload}` VaultEvents to emit
 *                           server-side (NO envelope — the dispatcher stamps
 *                           id/version/timestamp). A HIT emits NOTHING (the turn
 *                           advances only after the follow-up damage roll); a
 *                           MISS emits `turn_advance`; a DAMAGE roll emits
 *                           `monster_hp_change` then `turn_advance`.
 *   - `narrationDirective`— a `[RESOLVED BY SYSTEM: …] narra in 2ª persona`
 *                           directive for the narration-only LLM turn.
 *   - `damageRequest`     — on a HIT, the `Tira <die>+<bonus> per danni a
 *                           <name>` request string (the `per` lead-in is
 *                           BLOCKING — without it the client parser drops the
 *                           target and the stateless two-step breaks); else
 *                           `null`.
 */
export interface ResolveCombatResult {
  kind: 'to-hit' | 'damage' | 'none';
  events: VaultEvent[];
  narrationDirective: string;
  damageRequest: string | null;
}

/** Parsed numeric + dice shape of a rendered roll-result string. */
interface ParsedRoll {
  total: number;
  natural: number;
  bonus: number;
  diceKind: string;
}

/**
 * Parse a rendered roll-result string into `{total, natural, bonus, diceKind}`.
 *
 * The string is produced by `formatResultText` (`roll-request-button.tsx:125`):
 *   "🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3)."  → 18 / 15 / +3 / 1d20
 *   "🎲 I rolled **18** for 1d20 (attaccare Veyra)."           → 18 / 18 / +0 / 1d20
 *   "🎲 I rolled **23** for 1d20+3 (attaccare Veyra) (20+3)."  → 23 / 20 (nat-20)
 *
 * The breakdown is the LAST parenthetical (the label purpose comes first), so
 * the breakdown regex is anchored to end-of-string. A `+0` single-die roll
 * emits NO breakdown (`showBreakdown=false`, `roll-request-button.tsx:126`) →
 * fall back to `natural = total` (with +0 the die IS the total; also makes a
 * nat-20-on-+0 auto-hit). `bonus` is derived (`total - natural`) for robustness.
 *
 * Returns `null` when there is no `**N**` total — never throws.
 */
function parseRoll(rollResult: string): ParsedRoll | null {
  const totalM = /\*\*\s*(\d+)\s*\*\*/.exec(rollResult);
  if (!totalM) return null;
  const total = parseInt(totalM[1]!, 10);

  // Dice kind: the FIRST "NdM" token after "for".
  const diceM = /\bfor\s+((?:\d+)?d\d+)/i.exec(rollResult);
  const diceKind = diceM ? diceM[1]!.toLowerCase() : '';

  // Breakdown = the LAST parenthetical of digits/+/- ; absent on a +0 single die.
  const bkM = /\(([\d+\-\s]+)\)\s*\.?\s*$/.exec(rollResult.trim());
  const natural = bkM ? parseInt(bkM[1]!.split('+')[0]!.trim(), 10) : total;
  const bonus = total - natural;

  return { total, natural, bonus, diceKind };
}

/**
 * Match a player-named target to exactly one monster, CASE-INSENSITIVE EXACT
 * (T-08-01 mitigation, RESEARCH Open Q1).
 *
 * A single exact name match resolves directly. On a NAME COLLISION (>1 exact
 * match — the LLM can spawn duplicate-named monsters across sessions, e.g. a
 * stale orphan plus the live boss, observed in the Phase 08 operator smoke),
 * disambiguate to the live combat participant: ALIVE **and** present in
 * `turnOrder`. This rescues the common stale/orphan-spawn case WITHOUT weakening
 * T-08-01 — if >1 live participants still share the name (genuine ambiguity, or
 * 0 matches), return `null` → fall through to the normal turn.
 */
function matchMonster(
  encounter: EncounterState,
  target: string,
): EncounterState['monsters'][number] | null {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;
  const matches = encounter.monsters.filter((m) => m.name.toLowerCase() === needle);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    // Collision → narrow to the live combat participant(s): alive AND in turnOrder.
    const inOrder = new Set(encounter.turnOrder.map((t) => t.actorId));
    const live = matches.filter((m) => m.isAlive && inOrder.has(m.id));
    if (live.length === 1) return live[0]!;
  }
  return null;
}

/**
 * Deterministically resolve a PLAYER attack/damage roll against the active
 * encounter. Returns the events to emit, a narration directive, and (on a hit)
 * the damage-roll request — or `null` to fall through to the normal LLM turn.
 *
 * @param input.rollResult       — the player's "🎲 I rolled **N** for …" turn message.
 * @param input.encounter        — the active EncounterState (monsters + turnOrder).
 * @param input.defaultMonsterAc — AC used when a monster has no `ac` (D-08, default 12).
 * @param input.defaultDamageDie — damage die for the hit's damage request (D-08, default "1d6").
 *
 * NEVER throws (D-05/D-10): any unparseable roll, missing/ambiguous target, or
 * wrong dice+keyword combination returns `null`.
 */
export function resolveCombat(input: {
  rollResult: string;
  encounter: EncounterState;
  defaultMonsterAc?: number;
  defaultDamageDie?: string;
}): ResolveCombatResult | null {
  const { rollResult, encounter } = input;
  const defaultAc = input.defaultMonsterAc ?? DEFAULT_MONSTER_AC;
  const defaultDie = input.defaultDamageDie ?? DEFAULT_DAMAGE_DIE;

  // Gate 1: the string must carry a "**N**" total (else not a roll-result).
  const parsed = parseRoll(rollResult);
  if (!parsed) return null;
  const { total, natural, bonus, diceKind } = parsed;

  const lower = rollResult.toLowerCase();
  const isD20 = diceKind === '1d20' || diceKind === 'd20';
  // Keyword gates (require BOTH dice + keyword per D-03/D-04, RESEARCH Open Q2).
  const hasAttackKeyword = /attacc|colp/.test(lower);
  const hasDamageKeyword = /danni|danno/.test(lower);

  // ---- To-hit branch: 1d20 + attack keyword. ----
  if (isD20 && hasAttackKeyword) {
    // Target is the name after "attaccare"/"colpire".
    const tgtM = /(?:attaccare|attacca|colpire|colpisci)\s+([^.;:!?\n)]+)/i.exec(rollResult);
    if (!tgtM) return null;
    const monster = matchMonster(encounter, tgtM[1]!);
    if (!monster) return null;

    // Hit rule MIRRORED from attack.ts:345/361/365 on the ROLLED total (D-09):
    // nat-1 auto-miss; nat-20 auto-hit; else total >= AC.
    const ac = monster.ac ?? defaultAc;
    const hit = natural !== 1 && (natural === 20 || total >= ac);

    if (!hit) {
      return {
        kind: 'to-hit',
        events: [{ type: 'turn_advance', payload: {} }],
        narrationDirective: `[RESOLVED BY SYSTEM: l'attacco contro ${monster.name} ha MANCATO (${total} vs CA ${ac})] narra questo mancato in seconda persona, senza inventare danni.`,
        damageRequest: null,
      };
    }

    // HIT — the turn does NOT advance yet; it advances after the damage roll.
    // The `per` lead-in is BLOCKING (RESEARCH Pitfall 1) so the client parser
    // captures the target name into the damage roll's label.
    return {
      kind: 'to-hit',
      events: [],
      narrationDirective: `[RESOLVED BY SYSTEM: l'attacco contro ${monster.name} ha COLPITO (${total} vs CA ${ac}); ora tira i danni] narra questo colpo a segno in seconda persona.`,
      damageRequest: `Tira ${defaultDie}+${bonus} per danni a ${monster.name}`,
    };
  }

  // ---- Damage branch: non-d20 dice + damage keyword. ----
  if (!isD20 && hasDamageKeyword && diceKind !== '') {
    // Target is the name after "danni a".
    const tgtM = /danni\s+a\s+([^.;:!?\n)]+)/i.exec(rollResult);
    if (!tgtM) return null;
    const monster = matchMonster(encounter, tgtM[1]!);
    if (!monster) return null;

    return {
      kind: 'damage',
      events: [
        { type: 'monster_hp_change', payload: { id: monster.id, delta: -total } },
        { type: 'turn_advance', payload: {} },
      ],
      narrationDirective: `[RESOLVED BY SYSTEM: ${monster.name} subisce ${total} danni] narra questo colpo e i suoi effetti in seconda persona.`,
      damageRequest: null,
    };
  }

  // Fall-through (D-05/D-10): wrong dice+keyword combo, bare 1d20 with no attack
  // keyword, non-combat roll, etc. → normal LLM turn.
  return null;
}
