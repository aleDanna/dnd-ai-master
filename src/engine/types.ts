import type { Anthropic } from '@anthropic-ai/sdk';

// ─── Character (canonical, not yet persisted) ──────────────────────────────

export type Ability = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

export type Skill =
  | 'Acrobatics' | 'Animal Handling' | 'Arcana' | 'Athletics'
  | 'Deception' | 'History' | 'Insight' | 'Intimidation'
  | 'Investigation' | 'Medicine' | 'Nature' | 'Perception'
  | 'Performance' | 'Persuasion' | 'Religion' | 'Sleight of Hand'
  | 'Stealth' | 'Survival';

export type DamageType =
  | 'acid' | 'bludgeoning' | 'cold' | 'fire' | 'force' | 'lightning'
  | 'necrotic' | 'piercing' | 'poison' | 'psychic' | 'radiant'
  | 'slashing' | 'thunder';

export type ConditionSlug =
  | 'blinded' | 'charmed' | 'deafened' | 'frightened' | 'grappled'
  | 'incapacitated' | 'invisible' | 'paralyzed' | 'petrified' | 'poisoned'
  | 'prone' | 'restrained' | 'stunned' | 'unconscious' | 'exhaustion'
  // Mechanical buff markers (not strict SRD conditions, but tracked as condition-like state)
  | 'blessed' | 'baned' | 'shielded' | 'flying' | 'mage-armored' | 'helped';

export interface Character {
  id: string;
  name: string;
  level: number;
  /** Cumulative XP earned. D&D 5e: 0 at level 1, 300 at level 2, 900 at level 3, ... */
  xp: number;
  classSlug: string;
  raceSlug: string;
  backgroundSlug: string;
  abilities: Record<Ability, number>;
  proficiencyBonus: number;
  hpMax: number;
  ac: number;
  speed: number;
  proficiencies: {
    saves: Ability[];
    skills: Skill[];
    expertise: Skill[];
    weapons: string[];        // proficiency groups: "Simple" | "Martial" | individual slugs
    armor: string[];           // categories: "Light" | "Medium" | "Heavy" | "Shield"
    tools: string[];
    languages: string[];
  };
  /**
   * PHB §18.1 Inspiration: a single boolean flag — "you either have it or
   * you don't". The DM grants Inspiration for great roleplaying or memorable
   * accomplishments. The PC may spend it to gain ADV on one attack, ability
   * check, or saving throw (consumed regardless of outcome).
   */
  inspiration?: boolean;
  spellcasting: SpellcastingState | null;
  features: FeatureInstance[];   // race/class/bg/feat features w/ uses-left
  inventory: InventoryItem[];
  /**
   * PHB §10.1 — slugs of items currently attuned. A creature can be attuned
   * to AT MOST 3 items at any one time (`MAX_ATTUNED` in `engine/items.ts`).
   * Optional so legacy snapshots without this column still typecheck; the
   * snapshot/applicator default it to `[]`.
   */
  attunedItems?: string[];
  hitDiceMax: number;
  hitDieSize: number;             // 6 | 8 | 10 | 12
  /**
   * PHB §6.4 — special senses (darkvision, blindsight, tremorsense,
   * truesight) and an optional passive Perception override. Optional so
   * existing snapshots without this column continue to typecheck; the
   * applicator/snapshot default it to absent.
   */
  senses?: Senses;
}

// ─── Exploration: travel pace, light, senses, marching order (PHB §6) ──────

/** PHB §6.1 travel pace — Fast/Normal/Slow. */
export type TravelPace = 'fast' | 'normal' | 'slow';

/** PHB §6.4 ambient light levels for the current area. */
export type LightLevel = 'bright' | 'dim' | 'darkness';

/**
 * PHB §6.4 special senses + optional passive Perception override.
 * All fields optional: a creature with no special senses simply has none.
 * Range values are in feet.
 */
export interface Senses {
  darkvisionFt?: number;
  blindsightFt?: number;
  tremorsenseFt?: number;
  truesightFt?: number;
  /** Optional override; otherwise derived from skill. */
  passivePerception?: number;
}

/**
 * PHB §6.2 marching order — three ordered ranks. Each rank holds the
 * actor IDs (PC + companions/NPCs) currently in that position. Used
 * narratively for ambushes/area effects; the engine does not enforce
 * positional rules here.
 */
export interface MarchingOrder {
  front: string[];
  middle: string[];
  back: string[];
}

/**
 * Engine-side travel state. Persisted on session_state.travel.
 * All fields optional so a fresh session has no travel context until
 * the master sets one (defaults to "exploration without explicit
 * travel" — bright light, no specific pace, no marching order).
 */
export interface TravelState {
  pace?: TravelPace;
  lightLevel?: LightLevel;
  marchingOrder?: MarchingOrder;
}

export interface SpellcastingState {
  ability: Ability;
  spellSaveDC: number;
  spellAttackBonus: number;
  slotsMax: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
  spellsKnown: string[];          // slugs
  spellsPrepared: string[];       // slugs (subset of known, for prep casters)
}

export interface FeatureInstance {
  slug: string;                   // e.g. 'rage', 'second_wind', 'channel_divinity'
  source: 'class' | 'race' | 'background' | 'feat';
  usesMax: number | 'unlimited';
  description: string;
}

export interface InventoryItem {
  slug: string;
  qty: number;
  equipped: boolean;
}

// ─── Magic items: rarity, category, attunement (PHB §10.1) ────────────────

/**
 * PHB §10.1 magic-item rarity ladder. The order of the literals matters —
 * `RARITY_ORDER` in `src/engine/items.ts` mirrors it for `rarityTier`.
 */
export type Rarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'very_rare'
  | 'legendary'
  | 'artifact';

/**
 * PHB §10.1 magic-item categories. Determines how the item is worn / used —
 * the engine uses this only for narrative grouping; the master is responsible
 * for enforcing per-category attunement effects (e.g. a single ring at a time).
 */
export type ItemCategory =
  | 'armor'
  | 'weapon'
  | 'wondrous'
  | 'potion'
  | 'scroll'
  | 'ring'
  | 'rod'
  | 'staff'
  | 'wand';

/**
 * Codex-side metadata for a named magic item. All fields optional so existing
 * named_items continue to validate as legal Phase 1-4 data; Phase 5 introduces
 * the columns and the typed view sits on top of them.
 */
export interface ItemMeta {
  rarity?: Rarity;
  /** PHB §10.1 broad category (used for filtering and narrative grouping). */
  category?: ItemCategory;
  /**
   * True if the PC must spend a 1-hour bonding (during a short rest) to gain
   * the item's benefits. The engine doesn't enforce the rest itself — calling
   * `attune` is a narrative-driven event.
   */
  attunementRequired?: boolean;
  /**
   * Free-text prerequisite. The master is responsible for verifying it
   * before calling `attune`; the engine only validates the cap and inventory
   * possession.
   */
  attunementPrereq?: string;
  /** Marker for cursed items (Remove Curse / specific quest to break). */
  cursed?: boolean;
  /** Marker for sentient items (PHB §10.4 — alignment, language, goals). */
  sentient?: boolean;
}

// ─── Combat actor (NPCs, monsters, hostile or allied) ──────────────────────

export interface CombatActor {
  id: string;
  kind: 'pc' | 'monster' | 'npc';
  name: string;
  monsterSlug?: string;           // if kind === 'monster'
  hpMax: number;
  ac: number;
  abilities: Record<Ability, number>;
  proficiencyBonus: number;
  initiativeBonus: number;
  resistances: DamageType[];
  immunities: DamageType[];
  vulnerabilities: DamageType[];
  conditionImmunities: ConditionSlug[];
  /**
   * PHB §6.4 — special senses (darkvision, blindsight, tremorsense,
   * truesight). Optional: most baseline humanoids have none and rely
   * on normal sight.
   */
  senses?: Senses;
}

// ─── Engine state (runtime-only — Plan D will persist this) ────────────────

export interface ConditionInstance {
  slug: ConditionSlug;
  source: string;                 // narrative source: e.g. "goblin's bite"
  durationRounds: number | 'until_removed';
  appliedRound: number;
}

export interface ConcentrationState {
  spellSlug: string;
  slotLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  startedRound: number;
}

export interface ResourceUsage {
  // Per-character resource trackers, keyed by feature slug.
  // Examples: { rage: 1, second_wind: 0, action_surge: 0 }
  [featureSlug: string]: number;
}

export interface TurnState {
  actionUsed: boolean;
  bonusUsed: boolean;
  reactionUsed: boolean;
  movementSpentFt: number;
  freeInteractionsUsed: number;
  /** Until next turn: incoming attacks have DIS (if can see attacker), DEX saves ADV. */
  dodging: boolean;
  /** This turn: leaving engagement does not provoke OA. */
  disengaged: boolean;
  /** This turn: effective movement budget is doubled. */
  dashed: boolean;
  /** Stored Ready action: trigger description + planned action. Cleared on next start_turn. */
  readied?: { trigger: string; action: string };
}

// ─── Cover (PHB §3.12) ─────────────────────────────────────────────────────

/**
 * PHB §3.12 — degree of cover between attacker and target. The same bonus
 * applies to AC (vs attacks) and to DEX saves (vs effects originating from
 * the cover side). 'total' makes the target untargettable.
 */
export type CoverLevel = 'none' | 'half' | 'three-quarters' | 'total';

export interface Position {
  /** Abstract distance band from the action focus. */
  band: 'engaged' | 'near' | 'far' | 'distant';
  /** IDs of hostile actors currently within melee reach (engagement). */
  engagedWith: string[];
}

export interface CombatState {
  round: number;
  turnOrder: { actorId: string; initiative: number }[];
  currentIdx: number;
}

export interface ActorRuntimeState {
  actorId: string;
  hpCurrent: number;
  tempHp: number;
  conditions: ConditionInstance[];
  deathSaves: { successes: number; failures: number };
  /**
   * Optional exhaustion track (0..6). Mirrors any 'exhaustion' entry in
   * `conditions` for use by the effect resolver. Will be fully wired by
   * later tasks; included here so engine helpers can already consume it.
   */
  exhaustionLevel?: number;
  /**
   * Outcome flags derived from death-save resolution. `stable` means the
   * PC accumulated 3 successes and is no longer rolling; `dead` means 3
   * failures. Optional so existing constructors don't need updates.
   */
  flags?: { stable?: boolean; dead?: boolean };
  /**
   * If set, the actor is concentrating on a spell. Per PHB §8.8, only one
   * concentration spell may be active at a time; taking damage triggers a
   * CON save (DC = max(10, ⌊damage/2⌋)) to maintain it.
   */
  concentratingOn?: ConcentrationState;
  // For PCs only:
  hitDiceRemaining?: number;
  spellSlotsUsed?: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
  resourcesUsed?: ResourceUsage;
  /**
   * Per-turn action economy budget. Reset by `start_turn` mutation. Optional
   * for backward compat with Phase 1+2 actors that don't track action economy.
   */
  turnState?: TurnState;
  /**
   * Abstract distance band + engagement list. Optional for backward compat
   * with Phase 1+2 actors that don't have explicit positioning.
   */
  position?: Position;
}

export interface EngineState {
  characters: Character[];        // full PC sheets (canonical)
  combatActors: CombatActor[];    // monsters/NPCs in scene
  runtime: Record<string, ActorRuntimeState>;  // keyed by actor id
  combat: CombatState | null;
  scene: string;                  // short narrative summary
  /**
   * PHB §6 — exploration/travel state: pace, ambient light level, marching
   * order. Optional so existing snapshots stay backward-compatible; the
   * master sets fields explicitly when the party transitions to overland
   * travel or when light conditions change.
   */
  travel?: TravelState;
  /**
   * Master World Lore §5.1 — campaign tonal frame. One of 8 frames that
   * shapes narration style, NPC speech, combat consequences. Set via
   * `set_tonal_frame` tool; persisted at session-level. Optional so the
   * session works without an explicit frame (master uses default flavor).
   */
  tonalFrame?: TonalFrame;
  /**
   * Master Handbook §2.1 — detected player engagement profile(s). Master
   * registers via `set_engagement_profile` after observing the first few
   * turns. Defaults to empty array; the master then leans into scene
   * styles that reward these profiles.
   */
  engagementProfile?: EngagementProfile[];
}

// ─── NPC Three-Beat (Master Handbook §11.1) ───────────────────────────────

/**
 * Master World Lore §5.1 — 8 tonal frames that flavor a campaign. Each one
 * implies a register for NPC speech, magic flavor, combat consequences,
 * and prose density. See TONAL_FRAME_GUIDANCE in `src/engine/npc-tonal.ts`
 * for 1-2 sentence explanations the master can lean on.
 */
export type TonalFrame =
  | 'high_heroic'
  | 'sword_sorcery'
  | 'dark'
  | 'mythic'
  | 'cosmic_horror'
  | 'swashbuckling'
  | 'wuxia'
  | 'steampunk';

/**
 * Master Handbook §2.1 — 7 player engagement profiles. The master detects
 * the player's preferred style(s) from their first few turns and prioritises
 * scenes that reward those styles.
 */
export type EngagementProfile =
  | 'acting'
  | 'fighting'
  | 'instigating'
  | 'optimizing'
  | 'problem_solving'
  | 'storytelling'
  | 'exploring';

/**
 * Master Handbook §11.1 — every named NPC has an attitude toward the PC.
 * Used for narrative consistency and to drive the master's choice of
 * tone, body language, and willingness to assist or oppose.
 */
export type NPCAttitude = 'friendly' | 'indifferent' | 'hostile';

/**
 * Master Handbook §11.1 — the Three-Beat structure for an NPC: every
 * named NPC has a Want, a Fear, and a Quirk, plus an Attitude. Stored
 * on the codex_entities row (kind='npc') so the master sees them in
 * lookup_codex results and can keep characterisation consistent across
 * turns.
 */
export interface NPCBeats {
  want?: string;
  fear?: string;
  quirk?: string;
  attitude?: NPCAttitude;
}

// ─── Mutations (declarative ops to apply to state) ─────────────────────────

export type Mutation =
  | { op: 'set_hp'; actorId: string; hpCurrent: number }
  | { op: 'apply_damage'; actorId: string; amount: number; type: DamageType; isCrit?: boolean }
  | { op: 'heal'; actorId: string; amount: number }
  | { op: 'set_temp_hp'; actorId: string; amount: number }
  | { op: 'add_condition'; actorId: string; condition: ConditionInstance }
  | { op: 'remove_condition'; actorId: string; conditionSlug: ConditionSlug }
  | { op: 'use_spell_slot'; actorId: string; level: 1|2|3|4|5|6|7|8|9 }
  | { op: 'restore_spell_slot'; actorId: string; level: 1|2|3|4|5|6|7|8|9; amount: number }
  | { op: 'use_resource'; actorId: string; featureSlug: string; amount: number }
  | { op: 'restore_resource'; actorId: string; featureSlug: string; amount: number }
  | { op: 'spend_hit_die'; actorId: string }
  | { op: 'restore_hit_dice'; actorId: string; amount: number }
  | { op: 'add_inventory'; characterId: string; itemSlug: string; qty: number }
  | { op: 'remove_inventory'; characterId: string; itemSlug: string; qty: number }
  | { op: 'set_equipped'; characterId: string; itemSlug: string; equipped: boolean }
  | { op: 'recompute_ac'; characterId: string; newAc: number }
  | { op: 'level_up'; characterId: string; newLevel: number; hpDelta: number; newSlots?: Partial<Record<1|2|3|4|5|6|7|8|9, number>> }
  | { op: 'award_xp'; characterId: string; amount: number; reason?: string }
  | { op: 'death_save'; actorId: string; success: boolean; isCrit?: boolean }
  | { op: 'reset_death_saves'; actorId: string }
  | { op: 'set_stable'; actorId: string; stable: boolean }
  | { op: 'set_concentration'; actorId: string; spellSlug: string; slotLevel: 0|1|2|3|4|5|6|7|8|9; startedRound: number }
  | { op: 'break_concentration'; actorId: string; reason: 'damage' | 'incapacitated' | 'killed' | 'new_concentration' | 'manual' }
  | { op: 'concentration_check'; actorId: string; dc: number; spellSlug: string }
  | { op: 'set_combat'; combat: CombatState | null }
  | { op: 'advance_turn' }
  | { op: 'set_scene'; scene: string }
  | { op: 'start_turn'; actorId: string }
  | { op: 'consume_action'; actorId: string; kind: 'action' | 'bonus' | 'reaction' }
  | { op: 'consume_movement'; actorId: string; feet: number }
  | { op: 'take_dodge'; actorId: string }
  | { op: 'take_disengage'; actorId: string }
  | { op: 'take_dash'; actorId: string; extraSpeedFt: number }
  | { op: 'set_readied'; actorId: string; trigger: string; action: string }
  | { op: 'set_position'; actorId: string; position: Position }
  | { op: 'opportunity_attack_triggered'; attackerId: string; targetId: string }
  // PHB §18.1 — DM awards Inspiration; idempotent if PC already has it.
  | { op: 'grant_inspiration'; characterId: string }
  // Spend Inspiration to grant ADV on next d20; consumed on first roll.
  | { op: 'spend_inspiration'; characterId: string }
  // PHB §5.2 — stamps the timestamp of the most recent successful long rest.
  | { op: 'set_long_rest_at'; epochMs: number }
  // PHB §10.1 — attune the PC to a magic item (already in inventory). The
  // engine validates max 3 per PC and inventory possession; the applicator
  // appends the slug to `characters.attuned_items` (no-op if already present).
  | { op: 'attune'; characterId: string; itemSlug: string }
  // PHB §10.1 — break attunement to a magic item. Idempotent (no-op if not
  // currently attuned); removes the slug from `characters.attuned_items`.
  | { op: 'unattune'; characterId: string; itemSlug: string }
  // PHB §6.1 — set the party's travel pace (Fast/Normal/Slow). Persisted
  // on session_state.travel.pace; merges with any existing travel object.
  | { op: 'set_travel_pace'; pace: TravelPace }
  // PHB §6.4 — set the ambient light level for the current scene. Used by
  // check_vision to determine sight-based perception effects.
  | { op: 'set_light_level'; lightLevel: LightLevel }
  // PHB §6.2 — set the party's marching order (front/middle/back ranks).
  // Narrative-only; the engine doesn't enforce positional rules here.
  | { op: 'set_marching_order'; order: MarchingOrder }
  // PHB §6.4 — set special senses on a PC or combat actor (darkvision,
  // blindsight, tremorsense, truesight, optional passive Perception
  // override). Branches on actor type in the applicator.
  | { op: 'set_senses'; actorId: string; senses: Senses }
  // Master World Lore §5.1 — set the campaign's tonal frame (persists on
  // sessions.tonal_frame). One of 8 frames shaping narration style.
  | { op: 'set_tonal_frame'; frame: TonalFrame }
  // Master Handbook §2.1 — register the detected player engagement
  // profile(s). Persists on sessions.engagement_profile (jsonb array).
  | { op: 'set_engagement_profile'; profiles: EngagementProfile[] }
  // Master Handbook §11.1 — update the Want/Fear/Quirk/Attitude for an
  // existing NPC codex entry (kind='npc', matched by slug). Partial
  // updates merge with existing values; null/undefined fields are left
  // unchanged.
  | { op: 'update_npc_beats'; npcSlug: string; beats: NPCBeats };

// ─── Action results ────────────────────────────────────────────────────────

export interface DiceRoll {
  formula: string;                // "1d20+5"
  rolls: number[];                // [14] or [11, 17] for advantage
  modifier: number;
  total: number;
  meta?: Record<string, unknown>;
}

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  rolls: DiceRoll[];
  mutations: Mutation[];
  narrative?: string;             // optional human-readable summary
}

// ─── Tool definitions (Anthropic shape) ────────────────────────────────────

export type AnthropicTool = Anthropic.Messages.Tool;

export interface ToolDef {
  definition: AnthropicTool;
  // Plan D will call handlers via the registry in src/engine/tools/handlers.ts.
  // Each handler signature is `(state: EngineState, input: unknown) => ActionResult`.
}
