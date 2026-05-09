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
  | 'prone' | 'restrained' | 'stunned' | 'unconscious' | 'exhaustion';

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
  spellcasting: SpellcastingState | null;
  features: FeatureInstance[];   // race/class/bg/feat features w/ uses-left
  inventory: InventoryItem[];
  hitDiceMax: number;
  hitDieSize: number;             // 6 | 8 | 10 | 12
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
}

// ─── Engine state (runtime-only — Plan D will persist this) ────────────────

export interface ConditionInstance {
  slug: ConditionSlug;
  source: string;                 // narrative source: e.g. "goblin's bite"
  durationRounds: number | 'until_removed';
  appliedRound: number;
}

export interface ResourceUsage {
  // Per-character resource trackers, keyed by feature slug.
  // Examples: { rage: 1, second_wind: 0, action_surge: 0 }
  [featureSlug: string]: number;
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
  // For PCs only:
  hitDiceRemaining?: number;
  spellSlotsUsed?: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
  resourcesUsed?: ResourceUsage;
}

export interface EngineState {
  characters: Character[];        // full PC sheets (canonical)
  combatActors: CombatActor[];    // monsters/NPCs in scene
  runtime: Record<string, ActorRuntimeState>;  // keyed by actor id
  combat: CombatState | null;
  scene: string;                  // short narrative summary
}

// ─── Mutations (declarative ops to apply to state) ─────────────────────────

export type Mutation =
  | { op: 'set_hp'; actorId: string; hpCurrent: number }
  | { op: 'apply_damage'; actorId: string; amount: number; type: DamageType }
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
  | { op: 'set_combat'; combat: CombatState | null }
  | { op: 'advance_turn' }
  | { op: 'set_scene'; scene: string };

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
