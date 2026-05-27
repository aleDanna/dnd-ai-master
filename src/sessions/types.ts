import type { Mutation, ActionResult, EngineState } from '@/engine/types';
import type { Character as CharacterDbRow } from '@/db/schema';
import { envPositiveInt } from '@/lib/env';

export interface TurnRequest {
  sessionId: string;
  userId: string;
  playerMessage: string;
}

export type TurnEvent =
  | { type: 'player_message_persisted'; messageId: string }
  | { type: 'narrative_delta'; text: string }
  // Local-only: emitted when the streaming provider detects the model has
  // entered a chain-of-thought phase (either explicit <think> tag or
  // markerless reasoning opener). UI should show a "Master is thinking..."
  // placeholder until `thinking: end` fires or the first `narrative_delta`
  // arrives — whichever comes first.
  | { type: 'thinking'; state: 'start' | 'end' }
  | { type: 'tool_use_start'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_use_end'; toolUseId: string; ok: boolean; error?: string; rolls: ActionResult['rolls']; mutationCount: number }
  | { type: 'state_changed'; mutations: Mutation[] }
  | { type: 'turn_complete'; messageId: string; durationMs: number; toolCallCount: number; truncated: boolean; timedOut: boolean }
  | { type: 'turn_error'; reason: string; recoverable: boolean }
  // Phase 03-B (REQ-023) — emitted when `maybeCondense` actually fires
  // and shortens the in-loop history. Carries the token estimates so SSE
  // subscribers can log compression ratio without re-tokenizing.
  | { type: 'summarized'; tokensBefore: number; tokensAfter: number };

export interface SnapshotForModel {
  state: EngineState;
  characterMonoSpace: string;
  scene: string;
  language: string | null;
  /** All instance characters in this campaign, ordered by creation time. */
  party: CharacterDbRow[];
  /** The character whose turn it currently is (NULL when not yet set). */
  currentPlayerCharacterId: string | null;
  /** The viewing user's own character id within the party (NULL for spectators). */
  viewerCharacterId: string | null;
}

export const TURN_TOOL_CALL_CAP = 12;
/**
 * Tool-call cap for Phase 02 vault-mutation turns (`runVaultToolLoop`).
 *
 * Higher than the baked-path cap (12) because combat turns on the vault
 * path fire one `apply_event` per HP change / condition add / spell slot
 * use. A representative combat turn: 5 HP changes + 3 condition adds +
 * 2 spell slot uses + 2 read_vault_multi + 1 end_turn = 13 calls, leaving
 * headroom for multi-character turns that easily reach 18-20.
 *
 * The baked loop (no apply_event tool) continues to use the smaller cap.
 *
 * Phase 02 — locked by Decision 11 (Pitfall 4 from RESEARCH.md). Re-tune
 * after observing real combat sessions if needed.
 */
export const VAULT_TURN_TOOL_CALL_CAP = 20;
// Wall-clock budget for the full tool loop (one turn = N model round-trips).
// gpt-5 with reasoning routinely takes 20-40s per round-trip, and a turn that
// calls multiple tools (e.g. add_item + generate_scene_image) needs 2-3
// round-trips to also produce narration. 60s was too tight; default is now
// 120s, env-overridable for testing or slow networks.
export const TURN_TIMEOUT_MS = envPositiveInt('TURN_TIMEOUT_MS', 120000);
