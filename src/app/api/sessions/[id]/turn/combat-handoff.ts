/**
 * Phase 07 Plan 03 — combat turn interleaving helper.
 *
 * Pure function that derives the turn-handoff decision from an active
 * EncounterState without reading the filesystem. Called by the vault branch
 * of the turn route before the existing detectAddressee / computeTurnAdvance
 * path, which is preserved unchanged as a fallback.
 *
 * Threat model (T-07-03-01): actorId is used ONLY in a party.some() membership
 * check. Unknown strings (monster ids) never match a DB-sourced PC UUID, so
 * they cannot trigger an unauthorized player handoff.
 *
 * Determinism: no clock reads, no env reads, no randomness. Pure function.
 */
import type { EncounterState } from '@/ai/master/vault/projector';

/**
 * Three-way discriminated union for the combat handoff decision:
 *
 *   - `advance`  — the current actor is a PC in `party`; set cpcId to
 *                  `nextCharacterId` and emit a `turn-change` notification.
 *   - `skip`     — the current actor is a monster (not in party); no handoff.
 *                  The master runs the monster turn within its own response.
 *   - `fallback` — encounter is inactive, turnOrder is empty, or currentIdx is
 *                  out of range; the caller must use the existing
 *                  detectAddressee / computeTurnAdvance path unchanged.
 */
export type CombatHandoffResult =
  | { kind: 'advance'; nextCharacterId: string }
  | { kind: 'skip' }
  | { kind: 'fallback' };

/**
 * Derive the turn-handoff decision from the current EncounterState.
 *
 * @param encounter — the live EncounterState replayed from events.md.
 * @param party     — the session's party list (DB characters, ordered by
 *                    creation time). Used as the trust gate: only a UUID
 *                    that appears in this list triggers a PC handoff.
 *
 * @returns A `CombatHandoffResult`:
 *   - `{ kind:'advance', nextCharacterId }` when turnOrder[currentIdx].actorId
 *     is in party.
 *   - `{ kind:'skip' }` when turnOrder[currentIdx].actorId is NOT in party
 *     (monster turn).
 *   - `{ kind:'fallback' }` when the encounter is inactive, turnOrder is
 *     empty, or currentIdx is out of range — caller falls back to the existing
 *     detectAddressee / computeTurnAdvance logic.
 */
export function resolveCombatHandoff(args: {
  encounter: EncounterState;
  party: ReadonlyArray<{ id: string }>;
}): CombatHandoffResult {
  const { encounter, party } = args;

  // Gate 1: encounter must be active.
  if (!encounter.active) return { kind: 'fallback' };

  // Gate 2: turnOrder must be non-empty.
  if (encounter.turnOrder.length === 0) return { kind: 'fallback' };

  // Gate 3: currentIdx must be in range.
  const actor = encounter.turnOrder[encounter.currentIdx];
  if (!actor) return { kind: 'fallback' };

  // Trust gate (T-07-03-01 mitigation): only known PC UUIDs trigger a handoff.
  const isPC = party.some((p) => p.id === actor.actorId);
  if (isPC) {
    return { kind: 'advance', nextCharacterId: actor.actorId };
  }

  // Monster turn — the master runs it; no PC handoff.
  return { kind: 'skip' };
}
