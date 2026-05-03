import type { TurnEvent } from './types';

export type { TurnEvent };

export interface MessageRow {
  id: string;
  sessionId: string;
  role: 'player' | 'master' | 'system';
  content: string;
  createdAt: string;
}

export interface DiceRollRow {
  id: string;
  sessionId: string;
  kind: 'attack' | 'damage' | 'save' | 'check' | 'init' | 'generic';
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface CombatActorRow {
  id: string;
  sessionId: string;
  name: string;
  monsterSlug: string | null;
  hpCurrent: number;
  hpMax: number;
  initiative: number;
  isAlive: boolean;
  conditions: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];
}

export interface SessionRow {
  id: string;
  userId: string;
  characterId: string;
  premise: string;
  language: string | null;
  status: 'active' | 'ended';
  createdAt: string;
  updatedAt: string;
}

export interface SessionStateRow {
  sessionId: string;
  hpCurrent: number;
  tempHp: number;
  hitDiceRemaining: number;
  spellSlotsUsed: Record<string, number>;
  conditions: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];
  resourcesUsed: Record<string, number>;
  inCombat: boolean;
  combat: { round: number; turnOrder: { actorId: string; initiative: number }[]; currentIdx: number } | null;
  scene: string;
  sceneImageVersion: number;
  sceneImagePrompt: string | null;
}

/** Mutable subset of the character row that the right-pane UI cares about
 * for live updates. Identity fields (race, class, abilities, etc.) are not
 * shipped — they don't change mid-session and the SSR'd character covers
 * them. */
export interface CharacterPatch {
  id: string;
  name: string;
  level: number;
  xp: number;
  hpMax: number;
  ac: number;
  proficiencyBonus: number;
  inventory: { slug: string; qty: number; equipped: boolean }[];
  spellcasting: unknown;
  features: unknown;
}

export interface StateSnapshot {
  session: SessionRow;
  state: SessionStateRow;
  actors: CombatActorRow[];
  /** Live mutable fields; merge onto the SSR'd character. */
  character?: CharacterPatch;
}
