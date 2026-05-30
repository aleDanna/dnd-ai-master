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
import type { EncounterState } from '@/ai/master/vault/projector';
import type { VaultEvent } from '@/ai/master/vault/events-schema';
import { rollD20, rollDamage } from '@/engine/dice';
import { defaultRng, type Rng } from '@/engine/rand';

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
  // nat20 auto-hit, else total >= ac. NO crit-doubling.
  const hit = natural !== 1 && (natural === 20 || total >= ac);

  const events: VaultEvent[] = [];
  let damage: number | null = null;

  if (hit) {
    // Damage roll — NO crit-doubling (opts.crit never set; symmetric with v1).
    const dmg = rollDamage(input.damageDice, {}, rng);
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
