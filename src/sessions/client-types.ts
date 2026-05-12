import type { TurnEvent } from './types';

export type { TurnEvent };

export interface MessageRow {
  id: string;
  sessionId: string;
  role: 'player' | 'master' | 'system';
  content: string;
  /** Multiplayer: the character that authored a player message. Null for master/system. */
  authorCharacterId?: string | null;
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
  /** PHB §9.2 — per-turn action economy budget (combat). Optional for back-compat. */
  turnState?: {
    actionUsed: boolean;
    bonusUsed: boolean;
    reactionUsed: boolean;
    movementSpentFt: number;
    freeInteractionsUsed: number;
    dodging: boolean;
    disengaged: boolean;
    dashed: boolean;
    loadingShotUsed?: boolean;
    offHandAttackUsed?: boolean;
    readied?: { trigger: string; action: string };
  };
  /** PHB §3.5 — abstract distance band + engagement (combat). Optional for back-compat. */
  position?: {
    band: 'engaged' | 'near' | 'far' | 'distant';
    engagedWith: string[];
  };
  /** PHB §6.4 — special senses (range in feet). Optional. */
  senses?: {
    darkvisionFt?: number;
    blindsightFt?: number;
    tremorsenseFt?: number;
    truesightFt?: number;
    passivePerception?: number;
  };
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

export interface CampaignRow {
  id: string;
  userId: string;
  name: string;
  premise: string;
  style: string;
  language: string | null;
  tonalFrame: string | null;
  engagementProfile: string[];
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
  /** PHB §6 — exploration/travel context. Optional; when null/undefined the
   * session is in plain combat or default exploration without explicit travel. */
  travel?: {
    pace?: 'fast' | 'normal' | 'slow';
    lightLevel?: 'bright' | 'dim' | 'darkness';
    marchingOrder?: { front: string[]; middle: string[]; back: string[] };
  };
  /** PHB §9.2 — PC's per-turn action economy budget. Optional. */
  turnState?: {
    actionUsed: boolean;
    bonusUsed: boolean;
    reactionUsed: boolean;
    movementSpentFt: number;
    freeInteractionsUsed: number;
    dodging: boolean;
    disengaged: boolean;
    dashed: boolean;
    loadingShotUsed?: boolean;
    offHandAttackUsed?: boolean;
    readied?: { trigger: string; action: string };
  };
  /** PHB §3.5 — PC's abstract distance band + engagement. Optional. */
  position?: {
    band: 'engaged' | 'near' | 'far' | 'distant';
    engagedWith: string[];
  };
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
  /** PHB §18.1 Inspiration. */
  inspiration?: boolean;
  /** PHB §10.1 attunement (capped at 3). */
  attunedItems?: string[];
  /** PHB §8.4 currently held spellcasting focus. */
  equippedFocus?: { kind: 'arcane' | 'druidic' | 'holy' | 'instrument'; itemSlug: string };
  /** PHB §2.5 multi-class breakdown. The first entry is the starting class. */
  classes?: { slug: string; level: number; subclass?: string }[];
  /** PHB §6.4 special senses. */
  senses?: {
    darkvisionFt?: number;
    blindsightFt?: number;
    tremorsenseFt?: number;
    truesightFt?: number;
    passivePerception?: number;
  };
}

export interface StateSnapshot {
  session: SessionRow;
  state: SessionStateRow;
  actors: CombatActorRow[];
  /** Live mutable fields; merge onto the SSR'd character. */
  character?: CharacterPatch;
}
