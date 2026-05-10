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
  | 'blessed' | 'baned' | 'shielded' | 'flying' | 'mage-armored' | 'helped'
  // PHB §8.3 — gates verbal-component spellcasting; the silenced creature
  // cannot speak so any spell with a Verbal component fails. The applier
  // is a no-op (the gating is enforced by the component validator inside
  // `castSpell`); kept as a condition slug so the master can apply/remove
  // it through the normal apply_condition / remove_condition flow.
  | 'silenced'
  // Phase 11 — class-feature condition markers. These are NOT strict SRD
  // conditions; they tag mechanical state the engine consults at the right
  // resolution site (rage damage/resistance/STR ADV; bardic die granted to
  // an ally; sacred weapon attack-roll bonus; channel-divinity used flag).
  | 'raging' | 'bardic_inspired' | 'sacred_weapon' | 'channel_divinity_used';

/**
 * PHB §2.5 — multi-class breakdown entry. A PC's `Character.classes` is an
 * array of these; the FIRST entry is always the starting class. The sum of
 * `level` across entries equals `Character.level`. A subclass slug may be
 * attached to an entry (e.g., 'eldritch-knight' on a 'fighter') to drive
 * downstream casting rules (PHB §13.2 third-caster handling).
 */
export interface ClassLevel {
  /** Class slug (one of the 12 PHB classes). */
  slug: string;
  /** Levels accumulated in this class (>= 1). */
  level: number;
  /** Optional subclass / archetype slug. */
  subclass?: string;
}

export interface Character {
  id: string;
  name: string;
  level: number;
  /** Cumulative XP earned. D&D 5e: 0 at level 1, 300 at level 2, 900 at level 3, ... */
  xp: number;
  /** Primary class slug (legacy alias for `classes?.[0]?.slug`). Always populated. */
  classSlug: string;
  /**
   * PHB §2.5 — full multi-class breakdown. The first entry is the
   * starting class (matches `classSlug`). Optional so legacy snapshots
   * without the column continue to typecheck — the snapshot hydrator
   * backfills it from `classSlug` + `level` when missing.
   */
  classes?: ClassLevel[];
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
  /**
   * PHB §8.4 — currently held spellcasting focus. When set, the focus
   * satisfies the somatic free-hand requirement AND substitutes any
   * non-costly material component (a focus does NOT replace consumed
   * or gp-priced materials). Optional: many casters never bother
   * declaring a focus, in which case component validation falls back
   * to free-hand + explicit material possession.
   */
  equippedFocus?: EquippedFocus;
  /**
   * PHB §5 + DMG crafting rules: in-flight crafting projects the PC has
   * started during downtime. Each entry is a `CraftingProject` carrying
   * the recipe slug, kind (item/magic_item/scroll/potion), days
   * remaining, and gp already spent on materials. Empty by default;
   * managed via `start_crafting` / `progress_crafting` /
   * `complete_crafting` / `cancel_crafting` mutations. Optional so
   * legacy snapshots without the column still typecheck — the snapshot
   * hydrator defaults it to `[]`.
   */
  craftingProjects?: CraftingProject[];
}

// ─── Crafting (PHB §5 + DMG) ───────────────────────────────────────────────

/**
 * PHB §5 + DMG crafting rules: discriminator for the four categories of
 * craftable artefacts the engine tracks.
 *   - `item`        → mundane gear from the equipment list (price drives time)
 *   - `magic_item`  → DMG magic-item crafting (rarity drives time/gp)
 *   - `scroll`      → spell scroll, transcribed by a caster
 *   - `potion`      → healer's-kit / alchemy potion brewed from a spell
 */
export type CraftingKind = 'item' | 'magic_item' | 'scroll' | 'potion';

/**
 * In-flight crafting project pinned on a `Character`. Each project has a
 * stable `id` so the AI Master can address it across turns (start,
 * progress, complete, cancel). The project is removed from
 * `craftingProjects` on `complete_crafting` / `cancel_crafting`.
 */
export interface CraftingProject {
  /**
   * Unique identifier (UUID or slug+timestamp). Generated by the tool
   * layer when emitting `start_crafting`; the applicator just stores it.
   */
  id: string;
  /**
   * Slug of the resulting item (e.g. `'longsword'`,
   * `'potion-of-healing'`). On completion the applicator emits
   * `add_inventory` with this slug.
   */
  recipeSlug: string;
  /** Discriminator — drives requirement computation in the tool layer. */
  kind: CraftingKind;
  /** Days of work still remaining before the project can be completed. */
  daysRemaining: number;
  /** Cumulative gp spent on materials (cap = the requirement). */
  gpSpent: number;
  /**
   * Optional bookkeeping: the combat/narrative round in which the
   * project was started. Useful for the master to time-stamp downtime
   * activities; the engine itself does not consume this field.
   */
  startedRound?: number;
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

// ─── Spell components & spellcasting focus (PHB §8.3, §8.4) ───────────────

/**
 * PHB §8.3 — parsed Verbal/Somatic/Material flags for a spell. Computed
 * by `parseComponents` over the SRD components string (e.g. "V S M (a
 * sprig of mistletoe)"). Stored on results, not persisted.
 */
export interface SpellComponents {
  verbal: boolean;
  somatic: boolean;
  material: boolean;
  /** Free-text material description (e.g. "silver dust 25 gp consumed", "a sprig of mistletoe"). */
  materialDescription?: string;
  /** True if material has explicit cost (gp/sp/etc) or is consumed — focus cannot replace. */
  materialCostly?: boolean;
}

/**
 * PHB §8.4 — kind of spellcasting focus. Each kind matches a specific
 * subset of the 12 PHB classes (see `focusKindForClass` in
 * `engine/spells/components.ts`):
 *   - arcane: sorcerer / warlock / wizard
 *   - druidic: druid / ranger
 *   - holy:   cleric / paladin
 *   - instrument: bard
 */
export type FocusKind = 'arcane' | 'druidic' | 'holy' | 'instrument';

/**
 * PHB §8.4 — currently held focus on a Character. The kind must match
 * the caster's class via `focusKindForClass`; otherwise the focus
 * provides NO benefit during component validation.
 */
export interface EquippedFocus {
  kind: FocusKind;
  /** Inventory slug of the held focus (the engine validates it before set_focus). */
  itemSlug: string;
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
  /**
   * PHB §9.4 — set true after the actor fires a 'loading' weapon this turn.
   * Blocks subsequent loading-weapon shots in the same turn (one per
   * action/bonus/reaction). Reset by start_turn / newTurnState.
   */
  loadingShotUsed?: boolean;
  /**
   * PHB §3.15 — set true after the actor performs the bonus-action off-hand
   * attack of two-weapon fighting. Blocks subsequent off-hand attacks in the
   * same turn. Reset by start_turn / newTurnState.
   */
  offHandAttackUsed?: boolean;
  /**
   * PHB Rogue Sneak Attack — set true after the rogue lands Sneak Attack
   * extra dice on a hit this turn. Blocks subsequent sneak attack uses
   * the SAME turn (per the once-per-turn rule). Reset by start_turn.
   */
  sneakAttackUsed?: boolean;
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
  // PHB §2.5 — add (or re-level) one level of a class. If the slug already
  // appears in `characters.classes`, that entry's level is incremented; the
  // entry's subclass is overwritten when `subclass` is supplied. Otherwise a
  // new entry is appended. The applicator updates `characters.level` to be
  // the sum of all class levels.
  | { op: 'add_class_level'; characterId: string; classSlug: string; subclass?: string }
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
  | { op: 'update_npc_beats'; npcSlug: string; beats: NPCBeats }
  // PHB §9.4 — set turnState.loadingShotUsed = true (PC or NPC actor).
  // Used after an attack with a 'loading' weapon to block subsequent
  // shots within the same turn. Reset on start_turn.
  | { op: 'mark_loading_shot'; actorId: string }
  // PHB §3.15 — set turnState.offHandAttackUsed = true. Emitted alongside
  // a `consume_action kind:'bonus'` from the off-hand attack of two-weapon
  // fighting. Reset on start_turn.
  | { op: 'mark_offhand_attack'; actorId: string }
  // PHB §9.4 — decrement inventory[ammoSlug].qty by qty (default 1) on
  // a successful resolution of an ammunition weapon attack. Removes the
  // entry if qty reaches 0. PC-only.
  | { op: 'consume_ammo'; characterId: string; ammoSlug: string; qty: number }
  // PHB §8.4 — set the PC's currently held spellcasting focus. The kind
  // is one of arcane/druidic/holy/instrument (validated at the tool
  // layer); the itemSlug must be in the PC's inventory. The applicator
  // overwrites any existing focus; the engine does not enforce class
  // eligibility (focus-vs-class match is checked at component-validation
  // time so the PC may "carry" an unsuitable focus narratively).
  | { op: 'set_focus'; characterId: string; focus: EquippedFocus }
  // PHB §8.4 — clear the PC's currently held focus. Idempotent (no-op
  // when no focus is currently set).
  | { op: 'unset_focus'; characterId: string }
  // Phase 11 — generic class-feature consumption. Increments
  // runtime.resourcesUsed[featureSlug] by `uses` (default 1). Used by
  // the start_rage / use_action_surge / use_channel_divinity /
  // grant_bardic_inspiration / use_class_feature tools. Validation
  // (uses-remaining vs usesMax) is done at the tool layer; the
  // applicator stays permissive so a replayed event log applies cleanly.
  | { op: 'use_class_feature'; actorId: string; featureSlug: string; uses?: number }
  // Phase 11 — counter-mutation, decrements
  // runtime.resourcesUsed[featureSlug] (used by short_rest / long_rest
  // for class features that recharge between rests).
  | { op: 'restore_class_feature'; actorId: string; featureSlug: string; uses?: number }
  // Phase 11 — Lay on Hands pool tracker. The Paladin's pool is
  // 5 × paladin level (PHB Paladin Lay on Hands). The engine tracks the
  // SPENT amount on `runtime.resourcesUsed['lay_on_hands']`; remaining =
  // max - spent. delta is positive when spending (increases the spent
  // counter), negative on long rest (resets to 0 via restore_class_feature
  // or this op with a negative delta).
  | { op: 'modify_lay_on_hands_pool'; actorId: string; delta: number }
  // Phase 11 — Sneak Attack once-per-turn marker. Sets
  // turnState.sneakAttackUsed = true. Reset by start_turn.
  | { op: 'mark_sneak_attack'; actorId: string }
  // Phase 11 — Action Surge: reset turnState.actionUsed to false so the
  // fighter can take another action this turn.
  | { op: 'reset_action_for_surge'; actorId: string }
  // Phase 12 — Crafting (PHB §5 + DMG). Append the project to
  // `characters.craftingProjects`. The tool layer is responsible for
  // computing the project's daysRemaining/gpSpent up-front based on the
  // kind. The applicator stays permissive: re-applying with the same id
  // is idempotent (no duplicate). All four crafting ops are PC-only.
  | { op: 'start_crafting'; characterId: string; project: CraftingProject }
  // Phase 12 — advance an existing crafting project by `daysSpent` days.
  // The applicator clamps `daysRemaining` at 0 (cannot go negative) and
  // increments `gpSpent` by `gpDelta` (default 0). Idempotent at 0 days
  // remaining: callers can keep passing daysSpent to no further effect.
  | {
      op: 'progress_crafting';
      characterId: string;
      projectId: string;
      daysSpent: number;
      gpDelta?: number;
    }
  // Phase 12 — finish a project. The applicator validates
  // `daysRemaining === 0`, REMOVES the project from
  // `craftingProjects`, AND emits `add_inventory` for `recipeSlug`
  // (qty 1) so the resulting item lands in the PC's inventory in the
  // same transaction.
  | { op: 'complete_crafting'; characterId: string; projectId: string }
  // Phase 12 — abandon a project. Removes it from `craftingProjects`
  // without emitting `add_inventory`. Idempotent (no-op when the id is
  // not present).
  | { op: 'cancel_crafting'; characterId: string; projectId: string };

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
