import type { ActorRuntimeState, Mutation } from '../types';
import { newTurnState, canConsumeAction } from './turn-state';

/**
 * PHB §3.5 — the seven non-attack/cast standard actions plus use_object.
 *
 * - dash:       extra movement (= speed) this turn.
 * - disengage:  leaving threatened squares does not provoke OA this turn.
 * - dodge:      attackers DIS, your DEX saves ADV until next turn.
 * - help:       grant advantage on the beneficiary's next d20 (1 round).
 * - hide:       stealth check vs. perception/passive (DC supplied by master).
 * - search:     perception/investigation check (DC supplied by master).
 * - ready:      hold an action for a triggering condition.
 * - use_object: interact with an object (free interaction limit exceeded).
 */
export type StandardActionKind =
  | 'dash'
  | 'disengage'
  | 'dodge'
  | 'help'
  | 'hide'
  | 'ready'
  | 'search'
  | 'use_object';

export interface StandardActionInput {
  actorId: string;
  kind: StandardActionKind;
  /** For 'help': the beneficiary's actorId. */
  beneficiaryId?: string;
  /** For 'ready': the trigger description and the planned action. */
  trigger?: string;
  readyAction?: string;
  /** For 'hide' / 'search': the DC the master assigns. Defaults to 10. */
  dc?: number;
  /** Rogue Cunning Action: dash/disengage/hide as bonus action. */
  useBonusAction?: boolean;
  /** Current combat round (for narrative-bookkeeping in conditions). Defaults to 0. */
  currentRound?: number;
}

export interface StandardActionOutput {
  ok: boolean;
  error?: string;
  mutations: Mutation[];
  /**
   * Set when the standard action implies a follow-up d20 (hide → Stealth,
   * search → Perception). The AI Master should call ability_check to resolve.
   */
  rollNeeded?: {
    ability: 'DEX' | 'WIS';
    skill: 'Stealth' | 'Perception' | 'Investigation';
    dc: number;
  };
}

export function resolveStandardAction(
  input: StandardActionInput,
  runtime: ActorRuntimeState | undefined,
): StandardActionOutput {
  const ts = runtime?.turnState ?? newTurnState();
  const kind: 'action' | 'bonus' = input.useBonusAction ? 'bonus' : 'action';
  if (!canConsumeAction(ts, kind)) {
    return { ok: false, error: `${kind}_already_used`, mutations: [] };
  }

  const muts: Mutation[] = [
    { op: 'consume_action', actorId: input.actorId, kind },
  ];

  switch (input.kind) {
    case 'dash':
      muts.push({ op: 'take_dash', actorId: input.actorId, extraSpeedFt: 0 });
      return { ok: true, mutations: muts };
    case 'disengage':
      muts.push({ op: 'take_disengage', actorId: input.actorId });
      return { ok: true, mutations: muts };
    case 'dodge':
      muts.push({ op: 'take_dodge', actorId: input.actorId });
      return { ok: true, mutations: muts };
    case 'help':
      if (!input.beneficiaryId) {
        return { ok: false, error: 'help_requires_beneficiary', mutations: [] };
      }
      muts.push({
        op: 'add_condition',
        actorId: input.beneficiaryId,
        condition: {
          slug: 'helped',
          source: 'help-action',
          durationRounds: 1,
          appliedRound: input.currentRound ?? 0,
        },
      });
      return { ok: true, mutations: muts };
    case 'hide':
      return {
        ok: true,
        mutations: muts,
        rollNeeded: { ability: 'DEX', skill: 'Stealth', dc: input.dc ?? 10 },
      };
    case 'search':
      return {
        ok: true,
        mutations: muts,
        rollNeeded: { ability: 'WIS', skill: 'Perception', dc: input.dc ?? 10 },
      };
    case 'ready':
      if (!input.trigger || !input.readyAction) {
        return {
          ok: false,
          error: 'ready_requires_trigger_and_action',
          mutations: [],
        };
      }
      muts.push({
        op: 'set_readied',
        actorId: input.actorId,
        trigger: input.trigger,
        action: input.readyAction,
      });
      return { ok: true, mutations: muts };
    case 'use_object':
      // Object interaction; uses the action. No additional state mutation.
      return { ok: true, mutations: muts };
  }
}
