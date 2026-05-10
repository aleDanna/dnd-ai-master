import type { ActorRuntimeState, Mutation, Position } from '../types';
import { newTurnState, canMoveFurther } from './turn-state';
import { initialPosition, bandTransitionDistance, movementProvokesOA } from './positioning';

export interface ResolveMoveInput {
  actorId: string;
  toBand: Position['band'];
  /** Enemies whose engagement we're leaving on this transition. */
  leavesEngagementWith?: string[];
  /** Enemies whose engagement we're entering on this transition. */
  entersEngagementWith?: string[];
}

export interface ResolveMoveOutput {
  ok: boolean;
  error?: string;
  mutations: Mutation[];
}

export function resolveMove(
  input: ResolveMoveInput,
  runtime: ActorRuntimeState | undefined,
  baseSpeedFt: number,
): ResolveMoveOutput {
  const ts = runtime?.turnState ?? newTurnState();
  const from = runtime?.position ?? initialPosition();

  // Build the "to" position by removing departing engagements and adding new ones.
  const remainingEngagement = from.engagedWith.filter(
    (id) => !(input.leavesEngagementWith ?? []).includes(id),
  );
  const newEngagement = [
    ...remainingEngagement,
    ...(input.entersEngagementWith ?? []),
  ];
  // If we end up with engagements, band must be 'engaged'; otherwise honor caller's choice.
  const toBand: Position['band'] = newEngagement.length > 0 ? 'engaged' : input.toBand;
  const to: Position = { band: toBand, engagedWith: newEngagement };

  // Distance check
  const distance = bandTransitionDistance(from.band, toBand);
  if (!canMoveFurther(ts, baseSpeedFt, distance)) {
    return { ok: false, error: 'insufficient_movement', mutations: [] };
  }

  const oaTriggers = movementProvokesOA(from, to, ts.disengaged);

  const mutations: Mutation[] = [
    { op: 'consume_movement', actorId: input.actorId, feet: distance },
    { op: 'set_position', actorId: input.actorId, position: to },
    ...oaTriggers.map((enemyId) => ({
      op: 'opportunity_attack_triggered' as const,
      attackerId: enemyId,
      targetId: input.actorId,
    })),
  ];

  return { ok: true, mutations };
}
