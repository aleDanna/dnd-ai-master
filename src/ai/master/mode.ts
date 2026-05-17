import type { EngineState } from '@/engine/types';
import type { SnapshotForModel } from '@/sessions/types';

export type MasterMode = 'combat' | 'exploration' | 'narrative';

/**
 * Derive the active master mode from engine state. Used by the prompt
 * builder to load only the relevant mode block per turn. Combat wins
 * over travel (e.g. ambush en route). When neither is set we default
 * to narrative, which covers social scenes, exposition, and downtime.
 */
export function deriveMode(state: EngineState): MasterMode {
  if (state.combat !== null && state.combat !== undefined) return 'combat';
  if (state.travel?.pace !== undefined) return 'exploration';
  return 'narrative';
}

/**
 * Decide whether the spellcasting overlay block should be appended to
 * the wire prompt this turn. We tie this to the ACTIVE PC only (not the
 * whole party) — a fighter's turn doesn't need spell rules even if the
 * party has a wizard.
 */
export function needsSpellcastingOverlay(snapshot: SnapshotForModel): boolean {
  const activeId = snapshot.currentPlayerCharacterId;
  if (!activeId) return false;
  const pc = snapshot.party.find((c) => c.id === activeId);
  return pc?.spellcasting != null;
}
