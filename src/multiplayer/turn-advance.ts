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
 * The trustworthy signal is the actual DB state, not the tool-call events.
 * `tool_use_start` for `set_current_player` fires regardless of the tool's
 * outcome, so it can't tell us:
 *   - whether the handler accepted the characterId (Gemini Flash sometimes
 *     passes a name instead of the uuid → the handler rejects with
 *     `character-not-in-party` and no DB write happens)
 *   - whether the master targeted the current player by mistake (a no-op
 *     advance — handler succeeds but cpcId is unchanged)
 *
 * Instead, we compare the cpcId captured at the start of the turn
 * (`beforeCpcId`) with the cpcId after the tool loop ran (`afterCpcId`). If
 * they match, the master either forgot the tool, no-op'd it, or had it
 * rejected — in all three cases the player is stuck on the previous actor's
 * bubble unless we rotate.
 *
 * Begin turns skip the fallback entirely: the host opens the scene and is
 * supposed to play the first action, so rotating away from them would land
 * the cue on the wrong character.
 */
export function computeTurnAdvance(args: {
  isBegin: boolean;
  beforeCpcId: string | null;
  afterCpcId: string | null;
  party: PartyMember[];
}): TurnAdvanceDecision {
  if (args.isBegin) return { kind: 'skip' };
  if (args.party.length <= 1) return { kind: 'skip' };
  if (args.afterCpcId !== args.beforeCpcId) return { kind: 'skip' };
  const next = nextInParty(args.afterCpcId ?? '', args.party);
  if (next.id === args.afterCpcId) return { kind: 'skip' };
  return { kind: 'advance', nextCharacterId: next.id };
}
