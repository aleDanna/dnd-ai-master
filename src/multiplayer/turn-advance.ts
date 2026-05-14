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
 * Post-turn safety net for multiplayer sessions: decides whether the system
 * must round-robin the current player after a master turn has run.
 *
 * Priority of signals (highest first):
 *   1. `addresseeId` — derived from the master's prose. If the message
 *      addresses a specific PG by name ("Kank Reena, le parole..." at the
 *      start of a POV narration, or "Kank, cosa fai?" at the end), the
 *      player reads that and expects to act as that PG. We override
 *      anything the tool layer did so the cpcId matches the user-facing
 *      prose. This catches the case where the master called
 *      `set_current_player` with the WRONG id but the prose is internally
 *      consistent — the player should not be punished for the model's
 *      tool-call slip.
 *   2. `afterCpcId !== beforeCpcId` — the master successfully advanced via
 *      the tool. Trust it (skip).
 *   3. Round-robin fallback — the master neither addressed anyone by name
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
  /** Character id parsed from the master's prose. Optional. */
  addresseeId?: string | null;
}): TurnAdvanceDecision {
  if (args.isBegin) return { kind: 'skip' };
  if (args.party.length <= 1) return { kind: 'skip' };
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
 * Scan a master narration and return the character id the prose is addressing,
 * if any. The signal is a "<Name>," pattern at the start of a sentence —
 * either at the very start of the message ("Kank Reena, le parole di Bruce
 * risuonano in te..." opening a POV narration) or at the end ("Kank, cosa
 * fai?" closing with an action prompt).
 *
 * Scans the WHOLE message: the addressee is the LAST `<Name>,` match by
 * position. This catches both:
 *   - POV-opening addresses where the master narrates the actor's perspective
 *     at the start and ends with a generic action prompt ("Tira una prova"),
 *   - closing-prompt addresses where the action is asked at the end ("Kank,
 *     cosa fai?").
 *
 * Returns null when:
 *   - no party-name occurs after a sentence boundary in the message
 *   - multiple names match — we take the LAST one as the latest signal
 *
 * Intentionally narrow: bare mentions ("the merchant nods at Bruce.") don't
 * trigger, only "<Name>," after a sentence boundary or paragraph break. False
 * positives mis-route the turn, so we keep the lead-in set tight
 * (`[\n.!?:]`) and require an immediate comma after the name.
 */
export function detectAddressee(
  text: string,
  party: Array<{ id: string; name: string }>,
): { id: string } | null {
  if (!text || party.length === 0) return null;
  const matches: Array<{ id: string; index: number }> = [];
  for (const c of party) {
    if (!c.name) continue;
    const pattern = `(?:^|[\\n.!?:]\\s*)${escapeRegex(c.name)},`;
    const re = new RegExp(pattern, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
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
