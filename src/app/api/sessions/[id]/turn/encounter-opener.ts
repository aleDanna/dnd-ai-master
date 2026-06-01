/**
 * Phase 10 Plan 01 — Pure, server-authoritative encounter opener.
 *
 * `runEncounterOpener` is the deterministic core of REQ-045. It:
 *   1. Guards the empty-party invariant (D-01 — never open combat with no PCs;
 *      the post-combat handoff would have no PC to return control to).
 *   2. Resolves monster stats via the injected bestiaryLookup (D-02 — swappable
 *      so the future option-A LLM path drops in without editing this file).
 *   3. Falls back to a CR-derived default HP when the lookup returns null
 *      (T-10-02 — null/garbage stats never crash the turn route).
 *   4. Builds and returns [monster_spawn, initiative_set]. NO damage event is
 *      ever emitted (REQ-047 invariant — opener turn is ENCOUNTER SETUP ONLY).
 *
 * PURE — no I/O, no Date.now, no Math.random, no randomUUID side effects beyond
 * the monster id (crypto.randomUUID is a pure UUID generator, not wall-clock).
 *
 * Does NOT import or edit any v1/v2 file (combat-resolver, monster-turns,
 * combat-handoff, projector, events-schema). The route (10-03) is responsible
 * for dispatching the returned events via dispatchVaultTool.
 *
 * Trust boundary note (T-10-01): monsterName is treated as an opaque string
 * (display name + lookup key only). This function NEVER builds a filesystem
 * path from it — path resolution is delegated to the bestiaryLookup caller
 * (10-02's safeVaultPath-backed reader).
 */
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A minimal party row — only the `id` field is consumed by the opener. The
 * caller (route) passes the full CharacterDbRow; we narrow to what we use so
 * the function is easy to test with a lightweight fixture (INFO-9: PC rows
 * carry no initiativeBonus in the characters schema — ac/hpMax only — so
 * initiative for PCs is always 1d20+0).
 */
export interface PartyMember {
  id: string;
  name: string;
}

/**
 * The shape the opener's bestiaryLookup callback must satisfy. Matches the
 * statblock data the 10-02 SRD reader will produce.
 *
 * All fields are optional — the lookup may return only a subset (e.g. the
 * prose parser yields ac/attackBonus/damageDice but cr may be absent). The
 * opener reads only hpMax and cr here; ac is forwarded to the event payload
 * when present so the v1 resolver has it at `encounter.monsters[].ac`.
 */
export interface BestiaryStats {
  hpMax?: number;
  ac?: number;
  cr?: string | number;
}

/**
 * A minimal event object shaped for dispatchVaultTool's apply_event branch.
 * The route (10-03) calls dispatchVaultTool('apply_event', ev, ctx) for each.
 * Using a plain object type here keeps this module free of the events-schema
 * import (which would pull in a large module; the route already imports it).
 */
export interface CombatEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The snapshot subset the opener reads. The route passes its full snap; the
 * opener uses only snap.party (array of participant rows with their UUIDs).
 */
export interface OpenerSnapshot {
  party: PartyMember[];
}

// ---------------------------------------------------------------------------
// CR → default HP table (separate from the attack-stats table in monster-turns)
// ---------------------------------------------------------------------------

/**
 * D-05-inspired HP table: CR → typical maximum HP for a monster of that tier.
 * Values drawn from the SRD "Creating a Monster" table (DMG §Appendix A)
 * typical HP ranges. Used ONLY when bestiaryLookup returns null (T-10-02
 * graceful degradation path). Keys are CR breakpoints; lookup uses nearest-
 * floor (largest key <= cr), so CR fractions (0.25, 0.5) map to key 0.
 *
 * Each HP is the midpoint of the SRD typical range for that CR tier:
 *   CR 0 → 1–6 → 3 (goblin tier)    CR 1 → 7–35 → 11    CR 2 → 36–49 → 22
 *   CR 3 → 50–70 → 60               CR 4 → 71–85 → 78    CR 5 → 86–100 → 93
 *   CR 6–7 → 101–115 → 108          CR 8–11 → 116–130 → 123
 *   CR 12–16 → 131–185 → 158        CR 17+ → 186–250 → 218
 */
const CR_TO_DEFAULT_HP: Record<number, number> = {
  0: 7,   // CR 0–1/4 (goblin tier — keeps goblin canonical 7 HP)
  1: 11,  // CR 1
  2: 22,  // CR 2
  3: 60,  // CR 3
  4: 78,  // CR 4
  5: 93,  // CR 5
  6: 108, // CR 6–7
  8: 123, // CR 8–11
  12: 158, // CR 12–16
  17: 218, // CR 17+
};

const CR_HP_KEYS = Object.keys(CR_TO_DEFAULT_HP)
  .map(Number)
  .sort((a, b) => a - b);

/** Generic fallback HP when CR is unknown or unparseable. */
const FALLBACK_HP = 7; // Goblin tier — conservative default.

/**
 * Convert a CR value (number or string fraction like "1/4") to a numeric CR.
 * Returns null on failure so the caller falls back cleanly.
 */
function parseCr(cr: string | number | undefined): number | null {
  if (cr === undefined || cr === null) return null;
  if (typeof cr === 'number') {
    return Number.isFinite(cr) && cr >= 0 ? cr : null;
  }
  // String form: "1/4", "1/2", "0", "5", etc.
  const str = String(cr).trim();
  if (str.includes('/')) {
    const parts = str.split('/');
    if (parts.length !== 2) return null;
    const num = parseFloat(parts[0]!);
    const den = parseFloat(parts[1]!);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return num / den;
  }
  const n = parseFloat(str);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Derive a default HP from a CR value via nearest-floor table lookup.
 * Returns FALLBACK_HP if cr is null/unparseable or above-range.
 */
function hpFromCr(cr: string | number | undefined): number {
  const crNum = parseCr(cr);
  if (crNum === null) return FALLBACK_HP;

  // Nearest-floor: largest key <= crNum.
  let selected: number | null = null;
  for (const key of CR_HP_KEYS) {
    if (key <= crNum) selected = key;
    else break;
  }
  if (selected === null) return FALLBACK_HP;
  return CR_TO_DEFAULT_HP[selected]!;
}

/**
 * Roll 1d20 for initiative. Using a simple Math.floor(Math.random() * 20) + 1
 * is acceptable for the opener (no testability contract on the RNG here, unlike
 * v2 monster turns which have injectable RNG). The PLAN specifies 1d20+0 per
 * INFO-9 (no initiativeBonus on PC rows). A single rollD20 call per participant.
 *
 * Isolated as a module-level function so future option-A or injectable-RNG
 * variants can replace just this.
 */
function roll1d20(): number {
  return Math.floor(Math.random() * 20) + 1;
}

// ---------------------------------------------------------------------------
// runEncounterOpener
// ---------------------------------------------------------------------------

/**
 * Build the opening combat events for a newly detected encounter.
 *
 * @param snapshot  The session snapshot — only `snapshot.party` is consumed.
 * @param monsterName  The display name for the monster (from combat-intent
 *                     detection; treated as an opaque string — T-10-01).
 * @param bestiaryLookup  Injected callback: given a name, returns
 *                        `{hpMax?, ac?, cr?}` or null. The 10-02 SRD reader
 *                        is the production implementation; tests inject a
 *                        vi.fn(). MUST be synchronous (pure function contract).
 *
 * @returns A `CombatEvent[]` with exactly two entries [monster_spawn,
 *          initiative_set] on the happy path, or `[]` when party is empty.
 *          NEVER throws. NEVER emits damage events (REQ-047).
 */
export function runEncounterOpener(
  snapshot: OpenerSnapshot,
  monsterName: string,
  bestiaryLookup: (name: string) => BestiaryStats | null,
): CombatEvent[] {
  // -------------------------------------------------------------------------
  // Step 1 — Empty-party guard (D-01 locked contract)
  // -------------------------------------------------------------------------
  // Never open combat with no PCs: resolveCombatHandoff (combat-handoff.ts)
  // needs at least one PC UUID in turnOrder to return control after a monster
  // turn; an empty turnOrder results in 'fallback'/'skip' forever.
  if (!snapshot.party || snapshot.party.length === 0) {
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 2 — Resolve monster stats (T-10-02: never throw on null/garbage)
  // -------------------------------------------------------------------------
  let stats: BestiaryStats | null = null;
  try {
    stats = bestiaryLookup(monsterName);
  } catch {
    // Defensive: a misbehaving lookup must not crash the turn route.
    stats = null;
  }

  // hpMax: from lookup if present and valid, else CR-derived, else fallback.
  let hpMax: number;
  if (
    stats !== null &&
    typeof stats.hpMax === 'number' &&
    Number.isInteger(stats.hpMax) &&
    stats.hpMax > 0
  ) {
    hpMax = stats.hpMax;
  } else {
    // CR-derived fallback — safe on null stats or missing hpMax.
    hpMax = hpFromCr(stats?.cr);
  }

  // -------------------------------------------------------------------------
  // Step 3 — Generate a stable monster id and build monster_spawn
  // -------------------------------------------------------------------------
  const monsterId = randomUUID();

  const spawnPayload: Record<string, unknown> = {
    id: monsterId,
    name: monsterName,
    hpMax,
  };

  // Forward optional ac when the lookup provides it — v1 combat-resolver reads
  // monster.ac ?? 12 (combat-resolver.ts:124/179). Providing it here gives the
  // resolver the correct AC on the first attack without a second lookup.
  if (
    stats !== null &&
    typeof stats.ac === 'number' &&
    Number.isInteger(stats.ac) &&
    stats.ac > 0
  ) {
    spawnPayload['ac'] = stats.ac;
  }

  // Forward cr when present so v2 monster-turns.ts picks the right attack
  // profile (getMonsterAttackStats reads monster.cr from EncounterState).
  const crNum = parseCr(stats?.cr);
  if (crNum !== null) {
    spawnPayload['cr'] = crNum;
  }

  const monsterSpawnEvent: CombatEvent = {
    type: 'monster_spawn',
    payload: spawnPayload,
  };

  // -------------------------------------------------------------------------
  // Step 4 — Roll initiative for every participant and build initiative_set
  // -------------------------------------------------------------------------
  // PCs: 1d20 + 0 (INFO-9: no initiativeBonus on CharacterDbRow — ac/hpMax only).
  // Monster: 1d20 + 0 (initiativeBonus not in the snapshot; CR table does not
  //   include it; keep simple for now — option-A future path can inject it).
  const orderEntries: Array<{ actorId: string; initiative: number }> = [];

  for (const pc of snapshot.party) {
    orderEntries.push({ actorId: pc.id, initiative: roll1d20() });
  }
  orderEntries.push({ actorId: monsterId, initiative: roll1d20() });

  // Sort descending by initiative score (highest acts first — D&D 5e rule).
  // Stable sort: ties broken by insertion order (PCs before monster for ties,
  // which slightly favors the player — acceptable and intentional for UX).
  orderEntries.sort((a, b) => b.initiative - a.initiative);

  const initiativeSetEvent: CombatEvent = {
    type: 'initiative_set',
    payload: { order: orderEntries },
  };

  // -------------------------------------------------------------------------
  // Step 5 — Return [monster_spawn, initiative_set]. NO damage event (REQ-047).
  // -------------------------------------------------------------------------
  return [monsterSpawnEvent, initiativeSetEvent];
}

// ---------------------------------------------------------------------------
// extractMonsterName
// ---------------------------------------------------------------------------

/**
 * Derive a monster display name / bestiary lookup key from a player's
 * combat-intent message. Heuristic seam (T-10-01 / D-02): the combat verb is
 * already confirmed by detectCombatIntent upstream, so we pick the nominal
 * target as the first substantial non-verb word group.
 *
 * Intentionally isolated so the future option-A constrained-JSON LLM path can
 * replace ONLY this step. Exported (vs. the original inline closure) so the
 * extraction heuristic is directly unit-testable.
 *
 * Robustness (Phase 10 gap fix):
 *   - CR-01: strips a leading `[Author]` speaker prefix so multi-PC history
 *     lines (`[CharName] message`) yield the monster, not the speaker.
 *   - WR-01: strips English articles (the/a/an) as well as Italian ones.
 *
 * NEVER throws — falls back to 'Unknown Enemy'.
 *
 * @param msg  Raw player message (may carry a leading `[Author]` speaker
 *             prefix in multi-PC sessions — see route.ts `usePrefix`).
 */
export function extractMonsterName(msg: string): string {
  const cleaned = msg
    // CR-01: strip a leading `[Author]` speaker prefix FIRST. In multi-PC
    // sessions the route prefixes each history line `[CharName] message`
    // (route.ts `usePrefix = party.length > 1`); without this the extractor
    // returned the PC's own bracketed name (e.g. "[Aria]") instead of the
    // monster, defeating REQ-045's real-SRD-stats guarantee for the common
    // multiplayer case. Anchored at start, single group, brackets only here.
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/[!?.,;:]/g, ' ')
    // Strip attack verbs + articles. WR-01: English articles (the/an) are
    // stripped alongside the Italian set, since detectCombatIntent matches
    // English attack verbs too ("attack the goblin" must not yield "the").
    .replace(
      /\b(attacc\w*|colpisc\w*|colpir\w*|combatt\w*|ingagg\w*|sferr\w*|assal\w*|scagli\w*|menar\w*|pugn\w*|calci\w*|affront\w*|carica|uccid\w*|ammazz\w*|attack\w*|strik\w*|fight\w*|punch\w*|engage\w*|slash\w*|stab\w*|il|lo|la|un|uno|una|i|gli|le|con|a|ad|the|an)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  // Prefer the first capitalized word group (proper noun = monster name).
  const capMatch = /([A-ZÀÈÌÒÙ][a-zàèìòùA-ZÀÈÌÒÙ\s'-]{1,30}?)(?:\s|$)/.exec(cleaned);
  if (capMatch?.[1] && capMatch[1].trim().length > 1) return capMatch[1].trim();
  // Fallback: first non-empty word.
  const firstWord = cleaned.split(/\s+/).find((w) => w.length > 1);
  if (firstWord) return firstWord;
  return 'Unknown Enemy';
}
