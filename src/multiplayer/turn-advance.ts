import { nextInParty, type PartyMember } from './party';

/**
 * Decision returned by computeTurnAdvance.
 * - `skip`  → leave the session's currentPlayerCharacterId alone
 * - `advance` → set currentPlayerCharacterId to `nextCharacterId` and emit a
 *   turn-change notification
 */
export type TurnAdvanceDecision =
  | { kind: 'skip' }
  | { kind: 'advance'; nextCharacterId: string };

/**
 * Maximum number of consecutive beats one PG may stay active before the
 * fairness fallback kicks in. Picked as 2 to allow a short follow-up beat
 * ("Bruce opens the door; what's inside?") while preventing any single
 * player from monopolising the spotlight across an exploration / social
 * scene. Tune by adjusting this constant; tests assert against it.
 */
export const MAX_CONSECUTIVE_BEATS_ON_SAME_PG = 2;

/**
 * Post-turn safety net for multiplayer sessions: decides whether the system
 * must round-robin the current player after a master turn has run.
 *
 * Priority of signals (highest first):
 *   1. **Fairness fallback** — if the same PG has already been active for
 *      `MAX_CONSECUTIVE_BEATS_ON_SAME_PG` beats in a row and the master is
 *      about to keep them active again, force a round-robin rotation. This
 *      prevents the "main character" failure mode where the LLM keeps
 *      addressing the same PG and the other player becomes a spectator.
 *      Triggered ONLY when the master tried to keep the spotlight in place
 *      (no tool advance AND prose addresses the current PG or stays silent).
 *   2. `addresseeId` — derived from the master's prose. If the closing
 *      paragraph addresses a specific PG by name ("Kank, cosa fai?"), the
 *      player reads that and expects to act as that PG. We override anything
 *      the tool layer did so the cpcId matches the user-facing prose. This
 *      catches the case where the master called `set_current_player` with
 *      the WRONG id but the prose is internally consistent — the player
 *      should not be punished for the model's tool-call slip.
 *   3. `afterCpcId !== beforeCpcId` — the master successfully advanced via
 *      the tool. Trust it (skip).
 *   4. Round-robin fallback — the master neither addressed anyone by name
 *      nor moved cpcId. Rotate so the party doesn't deadlock.
 *
 * Begin turns skip the fallback entirely: the host opens the scene and is
 * supposed to play the first action.
 */
export function computeTurnAdvance(args: {
  isBegin: boolean;
  beforeCpcId: string | null;
  afterCpcId: string | null;
  party: PartyMember[];
  /** Character id parsed from the master's closing prose. Optional. */
  addresseeId?: string | null;
  /**
   * Number of beats the current cpcId has already been active for, BEFORE
   * this beat. Reset to 0 every time cpcId changes (master advance, prose
   * hand-off, prior fairness rotation). When this counter has already hit
   * `MAX_CONSECUTIVE_BEATS_ON_SAME_PG`, the fairness fallback fires and
   * forces a round-robin rotation regardless of prose. Defaults to 0 for
   * callers that don't track it — preserves the legacy behaviour.
   */
  consecutiveBeatsOnCurrent?: number;
}): TurnAdvanceDecision {
  if (args.isBegin) return { kind: 'skip' };
  if (args.party.length <= 1) return { kind: 'skip' };
  const consecutive = args.consecutiveBeatsOnCurrent ?? 0;
  const masterHeldSpotlight =
    args.afterCpcId === args.beforeCpcId &&
    (!args.addresseeId || args.addresseeId === args.afterCpcId);
  // Fairness fallback: the master is trying to keep the same PG active for a
  // third consecutive beat. Force-rotate to break the streak. The prose may
  // address that PG anyway — the player will see a brief mismatch but the
  // alternative (one player monopolising the spotlight) is worse.
  if (
    masterHeldSpotlight &&
    consecutive >= MAX_CONSECUTIVE_BEATS_ON_SAME_PG &&
    args.afterCpcId !== null
  ) {
    const next = nextInParty(args.afterCpcId, args.party);
    if (next.id !== args.afterCpcId) {
      return { kind: 'advance', nextCharacterId: next.id };
    }
  }
  if (args.addresseeId && args.party.some((p) => p.id === args.addresseeId)) {
    if (args.addresseeId === args.afterCpcId) return { kind: 'skip' };
    return { kind: 'advance', nextCharacterId: args.addresseeId };
  }
  if (args.afterCpcId !== args.beforeCpcId) return { kind: 'skip' };
  const next = nextInParty(args.afterCpcId ?? '', args.party);
  if (next.id === args.afterCpcId) return { kind: 'skip' };
  return { kind: 'advance', nextCharacterId: next.id };
}

/**
 * Scan a master narration and return the character id the closing prose is
 * addressing, if any. The signal is a "<Name>," pattern at the start of a
 * sentence in the tail of the message — that's how the master invites a
 * specific player to act ("Bruce, cosa fai?" / "Kank, your turn.").
 *
 * Returns null when:
 *   - no party-name occurs after a sentence boundary in the tail
 *   - multiple names match but none clearly closes the message (we take the
 *     LAST one — that's the closing addressee in practice)
 *
 * Intentionally narrow: bare mentions ("the merchant nods at Bruce.")
 * don't trigger, only "<Name>," after a sentence boundary or paragraph
 * break. False positives mis-route the turn, so we prefer false negatives
 * here — round-robin still catches deadlocks.
 */
export function detectAddressee(
  text: string,
  party: Array<{ id: string; name: string }>,
): { id: string } | null {
  if (!text || party.length === 0) return null;
  // Focus on the closing prose — the action prompt is in the final beat.
  const tail = text.slice(-500);
  const matches: Array<{ id: string; index: number }> = [];
  for (const c of party) {
    if (!c.name) continue;
    const pattern = `(?:^|[\\n.!?:]\\s*)${escapeRegex(c.name)},`;
    const re = new RegExp(pattern, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(tail)) !== null) {
      matches.push({ id: c.id, index: m.index });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.index - b.index);
  return { id: matches[matches.length - 1]!.id };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
