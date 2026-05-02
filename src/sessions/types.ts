import type { Mutation, ActionResult, EngineState } from '@/engine/types';

export interface TurnRequest {
  sessionId: string;
  userId: string;
  playerMessage: string;
}

export type TurnEvent =
  | { type: 'narrative_delta'; text: string }
  | { type: 'tool_use_start'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_use_end'; toolUseId: string; ok: boolean; error?: string; rolls: ActionResult['rolls']; mutationCount: number }
  | { type: 'state_changed'; mutations: Mutation[] }
  | { type: 'turn_complete'; messageId: string; durationMs: number; toolCallCount: number; truncated: boolean; timedOut: boolean }
  | { type: 'turn_error'; reason: string; recoverable: boolean };

export interface SnapshotForModel {
  state: EngineState;
  characterMonoSpace: string;
  scene: string;
  language: string | null;
}

export const TURN_TOOL_CALL_CAP = 12;
export const TURN_TIMEOUT_MS = 60_000;
