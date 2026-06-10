/**
 * Phase 09 Plan 02 — pure monster-turn primitives (v2 monster attacks).
 *
 * A SIBLING module next to `combat-resolver.ts` (NOT inside it): the v1 player
 * resolver stays untouched, and this file mirrors its "pure function, injectable
 * RNG, events out, never throws" contract. The loop (09-04) and route (09-06)
 * compose these primitives; this module is the deterministic, headless-testable
 * core of v2 combat.
 *
 * It is a colocated helper, NOT a Next.js route handler — there are NO `next/*`
 * imports and no `route.ts` exports. Per AGENTS.md the route tree uses a
 * non-standard Next.js, but a pure helper imported by the `/turn` route handler
 * is framework-agnostic and carries no Next.js coupling.
 *
 * What v1 did vs what v2 must do (why the RNG seam exists):
 *   - v1 `resolveCombat` only COMPARED a client-rolled d20 total against AC.
 *   - v2 must ROLL the d20 AND the damage AND pick a target server-side. All
 *     three draws (D-10) go through ONE injected `Rng` (default `defaultRng`,
 *     seeded with `makeSeededRng` in tests) — no `Math.random` anywhere — so the
 *     same seed reproduces an identical (natural, total, hit, damage, target)
 *     tuple. That is the testability contract.
 *
 * Threat model (Phase 09 §STRIDE):
 *   - T-09-04 (DoS): `cr` is validated (`Number.isFinite` + `>= 0`) before the
 *     table lookup; NaN/Infinity/negative/out-of-range fall back to the
 *     named-constant default — never throws.
 *   - T-09-05 (Tampering): attackBonus/damageDice derive ONLY from the CR table,
 *     a bestiary parse (09-03), or server constants — never from player input.
 *     Target ids/AC come from server-resolved EncounterState/Postgres.
 *   - T-09-06 (DoS): all randomness via the injected `Rng`; empty `livePcIds`
 *     returns `null` defensively so the loop can stop, never throws.
 *   - T-09-07 (Tampering): this function emits only the negative `delta`; the
 *     `hp_change` reducer clamps `max(0, hp+delta)` — HP never goes negative.
 */
import { applyEncounterEvent, type EncounterState } from '@/ai/master/vault/projector';
import type { VaultEvent } from '@/ai/master/vault/events-schema';
import { rollD20, rollDamage } from '@/engine/dice';
import { defaultRng, type Rng } from '@/engine/rand';
import { getBestiaryAttackStats } from '@/app/api/sessions/[id]/turn/monster-bestiary';

/**
 * D-06 named-constant default attack profile, mirroring v1's
 * `DEFAULT_MONSTER_AC = 12` (combat-resolver.ts:33-34). A monster with no `cr`
 * and no bestiary profile attacks with these.
 */
export const DEFAULT_MONSTER_ATTACK_BONUS = 4;
export const DEFAULT_MONSTER_DAMAGE_DIE = '1d6';

/**
 * Default PC AC used when a target PC is absent from `pcAcById` (defensive —
 * the route normally supplies every live PC's AC via the D-12 Postgres bridge).
 * Reuses v1's monster-AC default value so the fallback stays a named constant,
 * never an inline magic number.
 */
const DEFAULT_PLAYER_AC = 12;

/**
 * D-05 CR → (attackBonus, damageDice) table — RESEARCH Pattern 4's
 * cross-validated rows (09-RESEARCH.md:326-358). Keys are sparse CR breakpoints;
 * lookup is NEAREST-FLOOR (largest key <= cr). Every `damageDice` here MUST
 * match the dice.ts FORMULA_RE grammar `^(\d+)d(\d+)([+-]\d+)?$` so `rollDamage`
 * accepts it (asserted in the test suite).
 *
 * Cross-validated against live bestiary files: CR 5 → +7/2d6+4 (troll, exact),
 * CR 17 → +14/2d10+8 (adult red dragon, exact), CR 2 → +5/1d8+3 (bandit-captain
 * tier). See RESEARCH Pattern 4 for the full validation.
 */
const CR_TO_ATTACK_STATS: Record<number, { attackBonus: number; damageDice: string }> = {
  0: { attackBonus: 4, damageDice: '1d6' }, // CR 0–1/4 → goblin tier (== D-06 default)
  1: { attackBonus: 4, damageDice: '1d8' }, // CR 1
  2: { attackBonus: 5, damageDice: '1d8+3' }, // CR 2
  3: { attackBonus: 5, damageDice: '1d10+3' }, // CR 3
  4: { attackBonus: 5, damageDice: '2d6+3' }, // CR 4
  5: { attackBonus: 7, damageDice: '2d6+4' }, // CR 5 (troll ✓)
  6: { attackBonus: 7, damageDice: '2d8+4' }, // CR 6–7
  8: { attackBonus: 8, damageDice: '2d8+5' }, // CR 8–11
  12: { attackBonus: 10, damageDice: '3d8+5' }, // CR 12–16
  17: { attackBonus: 14, damageDice: '2d10+8' }, // CR 17+ (adult red dragon ✓)
};

/** The sorted CR breakpoints, ascending — computed once for the floor lookup. */
const CR_KEYS = Object.keys(CR_TO_ATTACK_STATS)
  .map(Number)
  .sort((a, b) => a - b);

/** An attack profile: the to-hit bonus + the damage dice formula. */
export interface MonsterAttackStats {
  attackBonus: number;
  damageDice: string;
}

/**
 * Resolve a monster's attack profile via a 3-level precedence (D-04/D-05/D-06):
 *
 *   1. `input.bestiary` — the parsed bestiary profile (09-03 produces this for
 *      the D-04 path). Takes precedence when present and non-null.
 *   2. `input.cr` — VALIDATED (`Number.isFinite(cr) && cr >= 0`), then a
 *      NEAREST-FLOOR table lookup (largest key <= cr; fractions like 0.25 →
 *      key 0). Out-of-range above the top key uses the top row (largest key
 *      <= cr); malformed cr (NaN/Infinity/negative) falls through to step 3.
 *   3. The named-constant default profile (D-06).
 *
 * NEVER throws (T-09-04): any malformed `cr` falls back to the default.
 *
 * Above-range choice (DOCUMENTED): `cr` above the top breakpoint (e.g. 999)
 * resolves to the CR 17 row — it is the largest key <= cr, consistent with the
 * nearest-floor rule — rather than the default. A CR above 17 is a powerful
 * monster, so the strongest tabled profile is the safer approximation.
 */
export function getMonsterAttackStats(input: {
  cr?: number;
  bestiary?: MonsterAttackStats | null;
}): MonsterAttackStats {
  // Level 1: bestiary profile (D-04) wins outright.
  if (input.bestiary) {
    return input.bestiary;
  }

  // Level 2: validated cr → nearest-floor table lookup (D-05).
  const cr = input.cr;
  if (cr !== undefined && Number.isFinite(cr) && cr >= 0) {
    // Largest table key <= cr (CR_KEYS is ascending).
    let chosen: number | null = null;
    for (const key of CR_KEYS) {
      if (key <= cr) chosen = key;
      else break;
    }
    if (chosen !== null) {
      return CR_TO_ATTACK_STATS[chosen]!;
    }
    // cr is a valid number below the floor key (0) — fall through to default.
  }

  // Level 3: named-constant default (D-06). Also the malformed-cr fallback.
  return { attackBonus: DEFAULT_MONSTER_ATTACK_BONUS, damageDice: DEFAULT_MONSTER_DAMAGE_DIE };
}

/**
 * The single-monster-turn result contract (mirrors v1's `ResolveCombatResult`,
 * combat-resolver.ts:58-63 — discriminated facts + events out). The loop returns
 * an array of these to the route, which emits each result's `events` and narrates
 * the facts.
 *
 *   - `natural` — the raw d20 face (1–20).
 *   - `total`   — natural + attackBonus.
 *   - `ac`      — the targeted PC's AC.
 *   - `damage`  — rolled damage on a hit; `null` on a miss.
 *   - `events`  — `[hp_change (on hit), turn_advance]` on a hit, or
 *                 `[turn_advance]` on a miss. NOTE v1 emitted `monster_hp_change`
 *                 (the PC hit the monster); v2 INVERTS this to `hp_change` with
 *                 `character: pcId` (the monster hits the PC).
 */
export interface MonsterTurnResult {
  monsterName: string;
  hit: boolean;
  natural: number;
  total: number;
  ac: number;
  damage: number | null;
  pcTargetId: string;
  events: VaultEvent[];
}

/**
 * Resolve ONE monster attack deterministically (D-09/D-10/D-11).
 *
 * Steps, all randomness through the single injected `rng` (default `defaultRng`):
 *   1. (D-11) Pick a RANDOM live PC from `livePcIds` via
 *      `rng.intInclusive(0, livePcIds.length - 1)`. A single-element pool always
 *      returns that PC (1v1 collapse). An EMPTY pool returns `null` (defensive —
 *      the loop stops; never throws).
 *   2. Resolve the target PC's AC from `pcAcById` (named-constant fallback, never
 *      an inline magic number).
 *   3. (D-09) Roll the d20 with the attack bonus and apply the v1 hit rule
 *      VERBATIM: `natural !== 1 && (natural === 20 || total >= ac)`.
 *   4. On a hit, roll damage with `rollDamage(dice, {}, rng)` — NO crit-doubling
 *      (`opts.crit` is never set; symmetric with v1, deferred to v3) — and emit
 *      `hp_change{character: pcId, delta: -damage}` then `turn_advance`.
 *      On a miss, emit `turn_advance` only.
 *
 * `livePcIds` MUST be pre-filtered by the caller to PCs that are in `turnOrder`
 * AND have `hpCurrent > 0` (D-11 — only live PCs are targetable).
 *
 * NEVER throws (T-09-06): an empty `livePcIds` returns `null`.
 */
export function resolveMonsterTurn(input: {
  monster: EncounterState['monsters'][number];
  attackBonus: number;
  damageDice: string;
  livePcIds: string[];
  pcAcById: Map<string, number>;
  rng?: Rng;
}): MonsterTurnResult | null {
  // Defensive edge (D-11 / T-09-06): no live PC → stop the loop, never throw.
  if (input.livePcIds.length === 0) return null;

  const rng = input.rng ?? defaultRng;

  // (D-11) Random live-PC target — collapses to the single PC in 1v1.
  const pcId = input.livePcIds[rng.intInclusive(0, input.livePcIds.length - 1)]!;
  const ac = input.pcAcById.get(pcId) ?? DEFAULT_PLAYER_AC;

  // (D-09) Attack roll via the injected RNG.
  const d20 = rollD20({ modifier: input.attackBonus }, rng);
  const natural = d20.rolls[0]!;
  const total = d20.total;

  // (D-09) v1 hit rule VERBATIM (combat-resolver.ts:180) — nat1 auto-miss,
  // nat20 auto-hit, else total >= ac.
  const hit = natural !== 1 && (natural === 20 || total >= ac);

  const events: VaultEvent[] = [];
  let damage: number | null = null;

  if (hit) {
    // Damage roll — a natural 20 doubles the damage DICE (rules.md §10;
    // rollDamage doubles the dice count, never the flat modifier). The
    // 2026-06-10 audit removed the original "NO crit-doubling" deviation —
    // the player side doubles too (resolveCombat), so the rule is symmetric.
    const dmg = rollDamage(input.damageDice, { crit: natural === 20 }, rng);
    damage = dmg.total;
    // v2 INVERTS v1: the PC takes damage → hp_change{character, delta:-damage}.
    events.push({ type: 'hp_change', payload: { character: pcId, delta: -damage } });
  }
  events.push({ type: 'turn_advance', payload: {} });

  return {
    monsterName: input.monster.name,
    hit,
    natural,
    total,
    ac,
    damage,
    pcTargetId: pcId,
    events,
  };
}

/**
 * D-03c safety iteration cap for the monster-turn loop — a NAMED constant, not
 * an inline magic number. Bounds total loop iterations so a degenerate state
 * (e.g. a `turn_advance` that never reaches a PC) cannot spin forever and hang
 * the request (T-09-11 DoS). Reaching it stops the loop CLEANLY with
 * `stopReason 'cap-reached'` and NEVER throws.
 *
 * 20 covers any realistic encounter: 5e initiative orders rarely exceed ~8
 * combatants, and a single round of monster turns before the next PC turn is at
 * most (turnOrder.length - 1) monster actions. 20 leaves generous headroom
 * (RESEARCH Pattern 6 starting value; Claude's discretion — documented here).
 */
export const MONSTER_LOOP_SAFETY_CAP = 20;

/**
 * Why the loop stopped (D-03 + D-14):
 *   - `pc-turn`     — the active actor is a live PC (or no live monster is
 *                     active): the player acts next. The normal, common stop.
 *   - `party-down`  — no live targetable PC remains (last-PC-KO, D-14): combat
 *                     is lost for the party. The combined directive signals it.
 *   - `cap-reached` — the safety cap bounded a degenerate loop (D-03c). Clean
 *                     stop, never a throw.
 */
export type MonsterLoopStopReason = 'pc-turn' | 'party-down' | 'cap-reached';

/**
 * The accumulated result of one monster-turn loop pass.
 *
 *   - `results`           — the per-monster turn results, in turn order.
 *   - `events`            — the concatenated VaultEvents from every result, in
 *                           order, for the route (09-06) to persist. The single
 *                           source of truth for HP/turn mutations (D-13); the
 *                           loop itself only mutates in-memory working copies.
 *   - `stopReason`        — why the loop stopped (see MonsterLoopStopReason).
 *   - `partyDown`         — true iff the loop stopped because the last live PC
 *                           was downed (D-14).
 *   - `narrationDirective`— the ONE combined Italian 2nd-person directive (D-15)
 *                           listing every outcome, or `null` when no monster
 *                           acted. Built ONCE per loop, never per monster.
 */
export interface MonsterLoopResult {
  results: MonsterTurnResult[];
  events: VaultEvent[];
  stopReason: MonsterLoopStopReason;
  partyDown: boolean;
  narrationDirective: string | null;
}

/** The Level-1 bestiary lookup seam (injectable for headless tests, T-09-22). */
type BestiaryLookup = (name: string) => Promise<MonsterAttackStats | null>;

/**
 * Run consecutive monster turns over an in-memory EncounterState + PC-HP working
 * copy until a stop condition fires (D-03, D-14).
 *
 * PURITY / DETERMINISM (D-10): the roll/target/stop/damage CORE is pure. The
 * loop operates on `structuredClone(args.encounter)` and a copy of
 * `args.pcHpById`, applies each result's events to the working encounter via the
 * pure `applyEncounterEvent` (so the next iteration sees the advanced turn), and
 * decrements the target PC's working HP manually (clamped at 0). It NEVER
 * mutates the caller's inputs (T-09-13). All randomness routes through the
 * injected `rng` (default `defaultRng`).
 *
 * THE ONLY I/O is the Level-1 bestiary read `getBestiaryAttackStats` (09-03),
 * injectable via `bestiaryLookup` for headless tests. That read NEVER throws —
 * it returns `null` on any miss/fs-error — and a `null` bestiary is the normal
 * "use the fallback" signal: `getMonsterAttackStats` then falls through to the
 * CR table (Level 2) / named-constant default (Level 3). So a bestiary read
 * failure mid-loop is absorbed: the monster uses fallback stats and the loop
 * CONTINUES — it never aborts (T-09-22).
 *
 * Per iteration (bounded by MONSTER_LOOP_SAFETY_CAP, D-03c):
 *   1. Derive the active actor `turnOrder[currentIdx]`. If the encounter is
 *      inactive or the actor is missing → stop defensively ('cap-reached'-class
 *      degenerate guard, but reported as 'pc-turn' since no monster can act).
 *   2. If the active actor is NOT a live monster (it is a PC, or a dead monster
 *      the reducer will skip) → stop 'pc-turn'. (A dead active monster cannot
 *      attack; advancing past it is the reducer's job at the next PC turn.)
 *   3. Compute the live PC pool (PCs in pcAcById with working HP > 0). Empty →
 *      stop 'party-down'.
 *   4. Resolve the 3-level attack profile (bestiary → cr-table → default) and
 *      `resolveMonsterTurn`. A `null` result (no live PC) → stop 'party-down'.
 *   5. Accumulate the result + its events; on a hit, decrement the target PC's
 *      working HP (clamped at 0). Apply the result's events to the working
 *      encounter (advances the turn; the PC `hp_change` is a no-op there).
 *   6. If every live PC is now downed → stop 'party-down'.
 *
 * NEVER throws — every degenerate path resolves to a stopReason.
 */
export async function runMonsterTurnLoop(args: {
  encounter: EncounterState;
  pcAcById: Map<string, number>;
  pcHpById: Map<string, number>;
  rng?: Rng;
  /** Injectable Level-1 bestiary lookup (defaults to the fs-backed 09-03 read). */
  bestiaryLookup?: BestiaryLookup;
}): Promise<MonsterLoopResult> {
  // Working copies — never mutate the caller's encounter or HP map (T-09-13).
  let workEncounter = structuredClone(args.encounter);
  const workHp = new Map(args.pcHpById);
  const lookup = args.bestiaryLookup ?? getBestiaryAttackStats;

  const results: MonsterTurnResult[] = [];
  const events: VaultEvent[] = [];
  let stopReason: MonsterLoopStopReason = 'cap-reached';
  let partyDown = false;

  // True iff at least one PC in pcAcById still has working HP > 0.
  const anyLivePc = (): boolean => {
    for (const pcId of args.pcAcById.keys()) {
      if ((workHp.get(pcId) ?? 0) > 0) return true;
    }
    return false;
  };

  let iterations = 0;
  while (iterations < MONSTER_LOOP_SAFETY_CAP) {
    iterations++;

    // (1) Active actor. Defensive: an inactive/empty encounter cannot have a
    // monster acting → treat as a PC turn (nothing for the loop to do).
    const active = workEncounter.turnOrder[workEncounter.currentIdx];
    if (!workEncounter.active || !active) {
      stopReason = 'pc-turn';
      break;
    }

    // (2) The active actor must be a LIVE monster; otherwise it is a PC (or a
    // dead monster the reducer skips) → the loop yields. D-14: if NO live PC
    // remains at this point (the loop advanced onto a downed PC because the last
    // live PC was just KO'd), this is a party-KO stop, not a normal PC turn — the
    // combined directive must signal the wipe. Otherwise the player acts next.
    const activeMonster = workEncounter.monsters.find(
      (m) => m.id === active.actorId && m.isAlive,
    );
    if (!activeMonster) {
      if (!anyLivePc()) {
        stopReason = 'party-down';
        partyDown = true;
      } else {
        stopReason = 'pc-turn';
      }
      break;
    }

    // (3) Live PC pool (D-11/D-14): PCs in pcAcById with working HP > 0.
    const livePcIds = workEncounter.turnOrder
      .map((t) => t.actorId)
      .filter((id) => args.pcAcById.has(id) && (workHp.get(id) ?? 0) > 0);
    if (livePcIds.length === 0) {
      stopReason = 'party-down';
      partyDown = true;
      break;
    }

    // (4) 3-level attack profile: bestiary (Level 1, isolated async, null on any
    // miss → never aborts the loop, T-09-22) → cr table (Level 2) → default
    // (Level 3). getMonsterAttackStats absorbs a null bestiary as "use fallback".
    const bestiary = await lookup(activeMonster.name);
    const stats = getMonsterAttackStats({ cr: activeMonster.cr, bestiary });

    const result = resolveMonsterTurn({
      monster: activeMonster,
      attackBonus: stats.attackBonus,
      damageDice: stats.damageDice,
      livePcIds,
      pcAcById: args.pcAcById,
      rng: args.rng,
    });
    // Defensive (D-11): resolveMonsterTurn returns null only when livePcIds is
    // empty — already guarded above, but handle it as party-down, never a throw.
    if (result === null) {
      stopReason = 'party-down';
      partyDown = true;
      break;
    }

    // (5) Accumulate, decrement the target PC's working HP (clamped at 0), then
    // apply the result's events to the working encounter (advances the turn; the
    // PC hp_change is a no-op in applyEncounterEvent — handled by the route's
    // per-character reducer downstream).
    results.push(result);
    events.push(...result.events);
    if (result.damage != null) {
      const current = workHp.get(result.pcTargetId) ?? 0;
      workHp.set(result.pcTargetId, Math.max(0, current - result.damage));
    }
    for (const ev of result.events) {
      workEncounter = applyEncounterEvent(workEncounter, ev);
    }

    // (6) If the last live PC was just downed → stop + party-KO (D-14). A
    // non-last KO leaves another live PC, so the loop continues.
    if (!anyLivePc()) {
      stopReason = 'party-down';
      partyDown = true;
      break;
    }
  }
  // If the while-condition exhausted the cap without an explicit break, the
  // default stopReason ('cap-reached') stands (D-03c) — clean stop, no throw.

  // (D-15) ONE combined narration directive for the whole loop — built ONCE
  // here, never inside the per-monster loop.
  const narrationDirective = buildMonsterLoopNarrationDirective(results, { partyDown });

  return { results, events, stopReason, partyDown, narrationDirective };
}

/**
 * The LOCKED closing instruction shared by every monster-loop directive — Italian,
 * 2nd person, no-roll/no-event (mirrors the v1 combat-resolver wording at
 * combat-resolver.ts:216, D-15 / PATTERNS.md:116-121).
 */
const MONSTER_LOOP_DIRECTIVE_CLOSER =
  'Narra questi esiti in seconda persona, in ordine; NON chiedere tiri e NON scrivere eventi JSON — il sistema ha già applicato danni e avanzamenti di turno.';

/**
 * Italian party-KO signal appended when the loop ended party-down (D-14), so the
 * narration-only LLM narrates the knock-out.
 */
const PARTY_DOWN_SIGNAL =
  "L'intero gruppo è a terra (0 PF): narra la sconfitta del party e la fine dello scontro, sempre in seconda persona.";

/**
 * Build the ONE combined narration directive listing every monster outcome (D-15).
 *
 * Composes a single `[RESOLVED BY SYSTEM: turni mostri — …]` directive: per
 * result, an Italian 2nd-person clause — `<monster> ti colpisce per <damage>
 * danni (<total> vs CA <ac>)` on a hit, `<monster> ti manca (<total> vs CA
 * <ac>)` on a miss — joined with `; `, then the LOCKED no-roll/no-event closer.
 * When `opts.partyDown` is true, appends the party-KO signal (D-14).
 *
 * Returns `null` for an empty `results` array (no monster acted → the route
 * injects nothing; never fabricates a fake outcome). Built ONCE per loop — never
 * one directive per monster (the D-15 single-combined-pass latency requirement,
 * critical on the Mac Mini M4).
 */
export function buildMonsterLoopNarrationDirective(
  results: MonsterTurnResult[],
  opts?: { partyDown?: boolean },
): string | null {
  if (results.length === 0) return null;

  const clauses = results.map((r) =>
    r.hit
      ? `${r.monsterName} ti colpisce per ${r.damage ?? 0} danni (${r.total} vs CA ${r.ac})`
      : `${r.monsterName} ti manca (${r.total} vs CA ${r.ac})`,
  );

  let directive = `[RESOLVED BY SYSTEM: turni mostri — ${clauses.join('; ')}] ${MONSTER_LOOP_DIRECTIVE_CLOSER}`;
  if (opts?.partyDown) {
    directive = `${directive} ${PARTY_DOWN_SIGNAL}`;
  }
  return directive;
}
