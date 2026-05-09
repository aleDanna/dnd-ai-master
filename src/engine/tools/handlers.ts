import type {
  ActionResult,
  DiceRoll,
  EngagementProfile,
  EngineState,
  LightLevel,
  MarchingOrder,
  Mutation,
  NPCBeats,
  Senses,
  TonalFrame,
  TravelPace,
} from '../types';
import {
  isValidTonalFrame,
  isValidEngagementProfile,
  isValidNPCAttitude,
} from '../npc-tonal';
import {
  fallingDamageFormula,
  lightEffects,
  suffocationSurvival,
} from '../exploration';
import { rollDice as rollDiceFn, rollD20 as rollD20Fn } from '../dice';
import { abilityCheck, savingThrow } from '../checks';
import { rollInitiative } from '../combat/initiative';
import { makeAttack } from '../combat/attack';
import { applyDamage } from '../combat/damage';
import { endTurn } from '../combat/turn';
import {
  resolveStandardAction,
  type StandardActionInput,
  type StandardActionKind,
} from '../combat/standard-actions';
import { resolveMove } from '../combat/movement';
import { castSpell } from '../spells';
import { applyCondition, removeCondition } from '../conditions';
import { useResource as consumeResource } from '../resources';
import { shortRest, longRest } from '../rests';
import { equip, unequip, recomputeAC } from '../equipment';
import { levelUp } from '../levelup';
import {
  dehydrationSaveDC,
  forcedMarchDC,
  starvationSurvivalDays,
} from '../survival';
import { abilityModifier } from '../modifiers';
import { MAX_ATTUNED } from '../items';

// Each handler receives the raw Anthropic tool input (an object literal),
// resolves the relevant entities from EngineState, and dispatches to the
// pure engine action. The resolution layer is what Plan D's master loop
// will sit on top of.

export type ToolHandler = (state: EngineState, input: Record<string, unknown>) => ActionResult;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  roll_dice: (_state, input) => {
    const formula = String(input.formula);
    const r = rollDiceFn(formula);
    return { ok: true, data: { total: r.total, rolls: r.rolls }, rolls: [r], mutations: [] };
  },

  roll_d20: (_state, input) => {
    const modifier = typeof input.modifier === 'number' ? input.modifier : 0;
    const r = rollD20Fn({
      modifier,
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
    return { ok: true, data: { total: r.total, rolls: r.rolls }, rolls: [r], mutations: [] };
  },

  ability_check: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const runtime = state.runtime[charId];
    return abilityCheck({
      char,
      skill: input.skill as never,
      ability: input.ability as never,
      dc: Number(input.dc),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
      runtime,
      useInspiration: input.useInspiration === true,
    });
  },

  saving_throw: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const runtime = state.runtime[charId];
    return savingThrow({
      char,
      ability: input.ability as never,
      dc: Number(input.dc),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
      runtime,
      useInspiration: input.useInspiration === true,
    });
  },

  roll_initiative: (state) => {
    return rollInitiative({ pcs: state.characters, monsters: state.combatActors });
  },

  make_attack: (state, input) => {
    const attackerId = resolveCharacterId(state, input.attacker);
    const attacker = state.characters.find((c) => c.id === attackerId);
    if (!attacker) return { ok: false, error: 'unknown_attacker', rolls: [], mutations: [] };
    const targetId = String(input.target);
    const target = state.combatActors.find((a) => a.id === targetId);
    if (!target) return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
    const weaponInput = input.weapon as Record<string, unknown>;
    if (!weaponInput || typeof weaponInput !== 'object') return { ok: false, error: 'bad_weapon', rolls: [], mutations: [] };
    const attackerRuntime = state.runtime[attackerId];
    const targetRuntime = state.runtime[targetId];
    return makeAttack({
      attacker,
      target,
      weapon: {
        name: String(weaponInput.name),
        damage: String(weaponInput.damage),
        damageType: weaponInput.damageType as never,
        profGroup: String(weaponInput.profGroup),
        useDex: weaponInput.useDex === true,
      },
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
      attackerRuntime,
      targetRuntime,
      ranged: input.ranged === true,
      meleeRange: typeof input.meleeRange === 'number' ? input.meleeRange : undefined,
      knockOut: input.knockOut === true,
      useInspiration: input.useInspiration === true,
    });
  },

  apply_damage: (state, input) => {
    const targetId = String(input.actor);
    const runtime = state.runtime[targetId];
    if (!runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const target = state.combatActors.find((a) => a.id === targetId) ?? state.characters.find((c) => c.id === targetId);
    if (!target) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return applyDamage({
      runtime,
      target: target as never,
      amount: Number(input.amount),
      type: input.type as never,
      isCrit: input.isCrit === true,
      currentRound: state.combat?.round ?? 0,
    });
  },

  end_turn: (state) => {
    if (!state.combat) return { ok: false, error: 'not_in_combat', rolls: [], mutations: [] };
    return endTurn({ combat: state.combat });
  },

  end_combat: (state) => {
    if (!state.combat) return { ok: false, error: 'not_in_combat', rolls: [], mutations: [] };
    return {
      ok: true,
      rolls: [],
      mutations: [{ op: 'set_combat', combat: null }],
      data: { roundsElapsed: state.combat.round },
    };
  },

  take_action: (state, input) => {
    const actorId = resolveCharacterId(state, input.actor ?? input.actorId);
    if (!actorId) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const kind = input.kind as StandardActionKind | undefined;
    if (!kind) return { ok: false, error: 'missing_kind', rolls: [], mutations: [] };
    const resolverInput: StandardActionInput = {
      actorId,
      kind,
      beneficiaryId:
        typeof input.beneficiaryId === 'string' ? input.beneficiaryId : undefined,
      trigger: typeof input.trigger === 'string' ? input.trigger : undefined,
      readyAction:
        typeof input.readyAction === 'string' ? input.readyAction : undefined,
      dc: typeof input.dc === 'number' ? input.dc : undefined,
      useBonusAction: input.useBonusAction === true,
      currentRound: state.combat?.round ?? 0,
    };
    const rt = state.runtime[actorId];
    const result = resolveStandardAction(resolverInput, rt);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'standard_action_failed', rolls: [], mutations: [] };
    }
    return {
      ok: true,
      data: result.rollNeeded ? { rollNeeded: result.rollNeeded } : {},
      rolls: [],
      mutations: result.mutations,
    };
  },

  move_to_band: (state, input) => {
    const actorId = resolveCharacterId(state, input.actor ?? input.actorId);
    if (!actorId) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const toBand = input.toBand as 'engaged' | 'near' | 'far' | 'distant' | undefined;
    if (!toBand) return { ok: false, error: 'missing_to_band', rolls: [], mutations: [] };
    const leavesEngagementWith = Array.isArray(input.leavesEngagementWith)
      ? (input.leavesEngagementWith as unknown[]).map((id) => String(id))
      : undefined;
    const entersEngagementWith = Array.isArray(input.entersEngagementWith)
      ? (input.entersEngagementWith as unknown[]).map((id) => String(id))
      : undefined;
    const rt = state.runtime[actorId];
    // Determine speed: PC has speed on Character; monsters default to 30ft.
    const character = state.characters.find((c) => c.id === actorId);
    const speed = character?.speed ?? 30;
    const result = resolveMove(
      { actorId, toBand, leavesEngagementWith, entersEngagementWith },
      rt,
      speed,
    );
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'move_failed', rolls: [], mutations: [] };
    }
    return { ok: true, data: {}, rolls: [], mutations: result.mutations };
  },

  // cast_spell moved to TOOL_HANDLERS_DB so it can fetch spellMeta from the
  // SRD when invoked with asRitual=true (PHB §8.13). See cast_spell handler
  // in TOOL_HANDLERS_DB below.

  apply_condition: (state, input) => {
    const targetId = String(input.actor);
    const target = state.combatActors.find((a) => a.id === targetId);
    const runtime = state.runtime[targetId];
    if (!target || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return applyCondition({
      target,
      runtime,
      condition: {
        slug: input.condition as never,
        source: String(input.source),
        durationRounds: input.durationRounds === 'until_removed' ? 'until_removed' : Number(input.durationRounds),
        appliedRound: state.combat?.round ?? 1,
      },
    });
  },

  remove_condition: (state, input) => {
    const targetId = String(input.actor);
    const runtime = state.runtime[targetId];
    if (!runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return removeCondition({ runtime, conditionSlug: input.condition as never });
  },

  use_resource: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return consumeResource({
      char,
      runtime,
      featureSlug: String(input.featureSlug),
      amount: Number(input.amount ?? 1),
    });
  },

  short_rest: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return shortRest({ char, runtime, hitDiceSpent: Number(input.hitDiceSpent ?? 0) });
  },

  // long_rest moved to TOOL_HANDLERS_DB so it can read the persisted
  // `last_long_rest_at` from session_state for the §5.2 24h cooldown
  // check. See the entry in TOOL_HANDLERS_DB below.

  equip: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return equip({ char, itemSlug: String(input.itemSlug) });
  },

  unequip: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return unequip({ char, itemSlug: String(input.itemSlug) });
  },

  recompute_ac: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return recomputeAC({ char });
  },

  level_up: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return levelUp({
      char,
      newLevel: Number(input.newLevel),
      hpRollMode: (input.hpRollMode as 'average' | 'rolled') ?? 'average',
    });
  },

  award_xp: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const amount = Math.max(0, Math.floor(Number(input.amount) || 0));
    if (amount === 0) return { ok: false, error: 'invalid_amount', rolls: [], mutations: [] };
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
    return {
      ok: true,
      rolls: [],
      mutations: [{ op: 'award_xp', characterId: char.id, amount, reason }],
      data: { newTotal: char.xp + amount, awarded: amount, reason },
    };
  },

  add_item: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const slug = String(input.slug || '').trim().toLowerCase();
    if (!slug) return { ok: false, error: 'invalid_slug', rolls: [], mutations: [] };
    const qty = Math.max(1, Math.floor(Number(input.qty ?? 1) || 1));
    return {
      ok: true,
      rolls: [],
      mutations: [{ op: 'add_inventory', characterId: char.id, itemSlug: slug, qty }],
      data: { slug, qty },
    };
  },

  remove_item: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const slug = String(input.slug || '').trim().toLowerCase();
    if (!slug) return { ok: false, error: 'invalid_slug', rolls: [], mutations: [] };
    const qty = Math.max(1, Math.floor(Number(input.qty ?? 1) || 1));
    return {
      ok: true,
      rolls: [],
      mutations: [{ op: 'remove_inventory', characterId: char.id, itemSlug: slug, qty }],
      data: { slug, qty },
    };
  },

  make_death_save: (state, input) => {
    const ref = input.actorId ?? input.actor;
    if (ref == null) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const actorId = resolveCharacterId(state, ref);
    return handleMakeDeathSave({ rng: Math.random }, state, { actorId });
  },

  stabilize: (state, input) => {
    const ref = input.actorId ?? input.actor;
    if (ref == null) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const actorId = resolveCharacterId(state, ref);
    const method = String(input.method) as 'medicine_check' | 'healing_kit' | 'spell';
    const medicineRollRaw = input.medicineRoll;
    const medicineRoll =
      typeof medicineRollRaw === 'number' && Number.isFinite(medicineRollRaw)
        ? medicineRollRaw
        : undefined;
    return handleStabilize({ rng: Math.random }, state, { actorId, method, medicineRoll });
  },

  concentration_check: (state, input) => {
    const ref = input.actorId ?? input.actor;
    if (ref == null) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const actorId = resolveCharacterId(state, ref);
    const dc = Number(input.dc);
    if (!Number.isFinite(dc)) return { ok: false, error: 'invalid_dc', rolls: [], mutations: [] };
    return handleConcentrationCheck({ rng: Math.random }, state, { actorId, dc });
  },

  grant_inspiration: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    const charId = resolveCharacterId(state, ref);
    return handleGrantInspiration(state, { character: charId });
  },

  spend_inspiration: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    const charId = resolveCharacterId(state, ref);
    return handleSpendInspiration(state, { character: charId });
  },

  forced_march: (state, input) => {
    const ref = input.actor ?? input.actorId ?? input.character;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    const hoursTraveledRaw = input.hoursTraveled;
    if (typeof hoursTraveledRaw !== 'number' || !Number.isFinite(hoursTraveledRaw)) {
      return { ok: false, error: 'invalid_hours', rolls: [], mutations: [] };
    }
    return handleForcedMarch({ rng: Math.random }, state, {
      actor: charId,
      hoursTraveled: hoursTraveledRaw,
    });
  },

  apply_starvation: (state, input) => {
    const ref = input.actor ?? input.actorId ?? input.character;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    const daysRaw = input.daysWithoutFood;
    if (typeof daysRaw !== 'number' || !Number.isFinite(daysRaw)) {
      return { ok: false, error: 'invalid_days', rolls: [], mutations: [] };
    }
    return handleApplyStarvation(state, {
      actor: charId,
      daysWithoutFood: daysRaw,
    });
  },

  apply_dehydration: (state, input) => {
    const ref = input.actor ?? input.actorId ?? input.character;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    const daysRaw = input.daysWithLessThanHalfWater;
    if (typeof daysRaw !== 'number' || !Number.isFinite(daysRaw)) {
      return { ok: false, error: 'invalid_days', rolls: [], mutations: [] };
    }
    return handleApplyDehydration({ rng: Math.random }, state, {
      actor: charId,
      daysWithLessThanHalfWater: daysRaw,
    });
  },

  attune: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    const slug = String(input.itemSlug ?? '').trim().toLowerCase();
    if (!slug) {
      return { ok: false, error: 'invalid_slug', rolls: [], mutations: [] };
    }
    return handleAttune(state, { character: charId, itemSlug: slug });
  },

  unattune: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    const slug = String(input.itemSlug ?? '').trim().toLowerCase();
    if (!slug) {
      return { ok: false, error: 'invalid_slug', rolls: [], mutations: [] };
    }
    return handleUnattune(state, { character: charId, itemSlug: slug });
  },

  set_travel_pace: (state, input) => {
    return handleSetTravelPace(state, { pace: input.pace as TravelPace });
  },

  set_light_level: (state, input) => {
    return handleSetLightLevel(state, { lightLevel: input.lightLevel as LightLevel });
  },

  set_marching_order: (state, input) => {
    return handleSetMarchingOrder(state, { order: input.order as MarchingOrder });
  },

  set_senses: (state, input) => {
    const ref = input.actor ?? input.actorId ?? input.character;
    if (ref == null) {
      return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    }
    const senses = input.senses as Senses;
    return handleSetSenses(state, { actor: String(ref), senses });
  },

  check_vision: (state, input) => {
    const ref = input.observer ?? input.actor ?? input.actorId;
    if (ref == null) {
      return { ok: false, error: 'unknown_observer', rolls: [], mutations: [] };
    }
    const distanceFt = Number(input.distanceFt);
    if (!Number.isFinite(distanceFt)) {
      return { ok: false, error: 'invalid_distance', rolls: [], mutations: [] };
    }
    const lightLevel =
      typeof input.lightLevel === 'string'
        ? (input.lightLevel as LightLevel)
        : undefined;
    return handleCheckVision(state, {
      observer: String(ref),
      distanceFt,
      lightLevel,
    });
  },

  apply_falling: (state, input) => {
    const ref = input.actor ?? input.actorId;
    if (ref == null) {
      return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    }
    const distanceFt = Number(input.distanceFt);
    if (!Number.isFinite(distanceFt)) {
      return { ok: false, error: 'invalid_distance', rolls: [], mutations: [] };
    }
    return handleApplyFalling({ rng: Math.random }, state, {
      actor: String(ref),
      distanceFt,
    });
  },

  apply_suffocation: (state, input) => {
    const ref = input.actor ?? input.actorId ?? input.character;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const secondsWithoutAir = Number(input.secondsWithoutAir);
    if (!Number.isFinite(secondsWithoutAir)) {
      return { ok: false, error: 'invalid_seconds', rolls: [], mutations: [] };
    }
    return handleApplySuffocation(state, {
      actor: String(ref),
      secondsWithoutAir,
    });
  },

  set_tonal_frame: (_state, input) => {
    return handleSetTonalFrame({ frame: input.frame as TonalFrame });
  },

  set_engagement_profile: (_state, input) => {
    const profiles = Array.isArray(input.profiles)
      ? (input.profiles as unknown[]).map((p) => String(p))
      : [];
    return handleSetEngagementProfile({ profiles });
  },

  update_npc_beats: (_state, input) => {
    const npcSlug = String(input.npcSlug ?? '').trim();
    const beats = (input.beats as Partial<NPCBeats> | undefined) ?? {};
    return handleUpdateNPCBeats({ npcSlug, beats });
  },
};

// ─── Pure death-save / stabilize handlers ──────────────────────────────────
// Exported separately so tests can drive them with a deterministic RNG. The
// registry entries above wrap them with Math.random for production use.

export function handleMakeDeathSave(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actorId: string },
): ActionResult<{
  roll: number;
  total: number;
  success: boolean;
  naturalTwenty?: boolean;
  naturalOne?: boolean;
}> {
  const rt = state.runtime[input.actorId];
  if (!rt) return { ok: false, error: 'unknown actor', rolls: [], mutations: [] };
  if (rt.hpCurrent > 0) return { ok: false, error: 'actor not at 0 HP', rolls: [], mutations: [] };
  if (rt.flags?.dead) return { ok: false, error: 'actor is already dead', rolls: [], mutations: [] };
  if (rt.flags?.stable) {
    return { ok: false, error: 'actor is stable, no save needed', rolls: [], mutations: [] };
  }

  const roll = Math.floor(ctx.rng() * 20) + 1;
  const formulaRoll: DiceRoll = {
    formula: '1d20',
    rolls: [roll],
    modifier: 0,
    total: roll,
    meta: { kind: 'save' },
  };

  if (roll === 20) {
    return {
      ok: true,
      data: { roll, total: roll, success: true, naturalTwenty: true },
      rolls: [formulaRoll],
      mutations: [
        { op: 'reset_death_saves', actorId: input.actorId },
        { op: 'set_hp', actorId: input.actorId, hpCurrent: 1 },
        { op: 'remove_condition', actorId: input.actorId, conditionSlug: 'unconscious' },
      ],
    };
  }
  if (roll === 1) {
    return {
      ok: true,
      data: { roll, total: roll, success: false, naturalOne: true },
      rolls: [formulaRoll],
      mutations: [
        { op: 'death_save', actorId: input.actorId, success: false },
        { op: 'death_save', actorId: input.actorId, success: false },
      ],
    };
  }
  const success = roll >= 10;
  return {
    ok: true,
    data: { roll, total: roll, success },
    rolls: [formulaRoll],
    mutations: [{ op: 'death_save', actorId: input.actorId, success }],
  };
}

export function handleStabilize(
  _ctx: { rng: () => number },
  state: EngineState,
  input: { actorId: string; method: 'medicine_check' | 'healing_kit' | 'spell'; medicineRoll?: number },
): ActionResult<{ stabilized: boolean }> {
  const rt = state.runtime[input.actorId];
  if (!rt) return { ok: false, error: 'unknown actor', rolls: [], mutations: [] };
  if (rt.hpCurrent > 0) return { ok: false, error: 'actor is not at 0 HP', rolls: [], mutations: [] };
  if (rt.flags?.dead) return { ok: false, error: 'actor is dead', rolls: [], mutations: [] };

  let stabilized = false;
  switch (input.method) {
    case 'healing_kit':
    case 'spell':
      stabilized = true;
      break;
    case 'medicine_check':
      if (input.medicineRoll == null) {
        return {
          ok: false,
          error: 'medicineRoll required for medicine_check method',
          rolls: [],
          mutations: [],
        };
      }
      stabilized = input.medicineRoll >= 10;
      break;
    default:
      return { ok: false, error: 'unknown stabilize method', rolls: [], mutations: [] };
  }

  if (!stabilized) {
    return { ok: true, data: { stabilized: false }, rolls: [], mutations: [] };
  }

  // PHB §3.19: stable but still unconscious — DO NOT remove the condition.
  const muts: Mutation[] = [
    { op: 'reset_death_saves', actorId: input.actorId },
    { op: 'set_stable', actorId: input.actorId, stable: true },
  ];
  return { ok: true, data: { stabilized: true }, rolls: [], mutations: muts };
}

/**
 * PHB §8.8: when a concentrating creature takes damage, they roll a CON save
 * (DC = max(10, ⌊damage/2⌋)) to maintain concentration. The DC is supplied by
 * the caller (apply_damage emits the precomputed value via the
 * concentration_check mutation). On failure we emit `break_concentration` with
 * reason='damage'; the applicator will clear `runtime.concentratingOn` on the
 * next turn.
 *
 * Pure: no DB access. The handler errors out if the actor isn't a known PC,
 * isn't concentrating, or the input is malformed (idempotency guard — the AI
 * Master should call this exactly once per concentration_check mutation).
 */
export function handleConcentrationCheck(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actorId: string; dc: number },
): ActionResult<{ roll: number; total: number; success: boolean }> {
  const rt = state.runtime[input.actorId];
  if (!rt) return { ok: false, error: 'unknown actor', rolls: [], mutations: [] };
  if (!rt.concentratingOn) {
    return { ok: false, error: 'actor not concentrating', rolls: [], mutations: [] };
  }
  const character = state.characters.find((c) => c.id === input.actorId);
  if (!character) {
    return { ok: false, error: 'concentration_check is PC-only', rolls: [], mutations: [] };
  }

  const conMod = Math.floor((character.abilities.CON - 10) / 2);
  const profBonus = character.proficiencies.saves.includes('CON')
    ? character.proficiencyBonus
    : 0;
  const roll = Math.floor(ctx.rng() * 20) + 1;
  const total = roll + conMod + profBonus;
  const success = total >= input.dc;

  const formulaRoll: DiceRoll = {
    formula: '1d20+CON',
    rolls: [roll],
    modifier: conMod + profBonus,
    total,
    meta: { kind: 'concentration_save' },
  };

  if (success) {
    return {
      ok: true,
      data: { roll, total, success: true },
      rolls: [formulaRoll],
      mutations: [],
    };
  }
  return {
    ok: true,
    data: { roll, total, success: false },
    rolls: [formulaRoll],
    mutations: [
      { op: 'break_concentration', actorId: input.actorId, reason: 'damage' },
    ],
  };
}

/**
 * PHB §18.1: DM-side Inspiration grant. Idempotent — granting Inspiration
 * to a PC who already has it is a no-op (returns ok:true with
 * `granted: false` and no mutation). On a fresh grant, returns ok:true
 * with `granted: true` and a `grant_inspiration` mutation.
 */
export function handleGrantInspiration(
  state: EngineState,
  input: { character: string },
): ActionResult<{ granted: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (char.inspiration) {
    // Already has Inspiration — PHB: "you either have it or you don't"
    // (no stacking). The grant succeeds in spirit but emits no mutation.
    return { ok: true, data: { granted: false }, rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { granted: true },
    rolls: [],
    mutations: [{ op: 'grant_inspiration', characterId: char.id }],
  };
}

/**
 * PHB §18.1: standalone spend (typically the player declares "I use my
 * Inspiration" without an associated d20 roll yet, e.g. before initiative).
 * Most spends should go through the `useInspiration` flag on make_attack /
 * ability_check / saving_throw — those tools both apply ADV AND emit the
 * spend in one tool call. This handler is a fallback for narrative spends
 * and for tests/debugging.
 */
export function handleSpendInspiration(
  state: EngineState,
  input: { character: string },
): ActionResult<{ spent: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!char.inspiration) {
    return { ok: false, error: 'no_inspiration', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { spent: true },
    rolls: [],
    mutations: [{ op: 'spend_inspiration', characterId: char.id }],
  };
}

/**
 * PHB §6.3: forced march. After 8 hours of travel in a day, the PC must roll
 * a CON save at the end of every additional hour (DC = 10 + 1 per hour past
 * 8). On failure, 1 level of exhaustion is applied (`add_condition` →
 * applicator stacks levels). On success, no mutation. ≤8 hours = no save.
 */
export function handleForcedMarch(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actor: string; hoursTraveled: number },
): ActionResult<{
  saveRoll: number;
  saveTotal: number;
  saveSuccess: boolean;
  exhaustionApplied: boolean;
  dc: number;
}> {
  const char = state.characters.find((c) => c.id === input.actor);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }

  const dc = forcedMarchDC(input.hoursTraveled);
  if (dc === 0) {
    return {
      ok: true,
      data: { saveRoll: 0, saveTotal: 0, saveSuccess: true, exhaustionApplied: false, dc: 0 },
      rolls: [],
      mutations: [],
    };
  }

  const conMod = abilityModifier(char.abilities.CON);
  const profBonus = char.proficiencies.saves.includes('CON') ? char.proficiencyBonus : 0;
  const roll = Math.floor(ctx.rng() * 20) + 1;
  const total = roll + conMod + profBonus;
  const success = total >= dc;

  const formulaRoll: DiceRoll = {
    formula: '1d20+CON',
    rolls: [roll],
    modifier: conMod + profBonus,
    total,
    meta: { kind: 'save', subtype: 'forced_march', dc },
  };

  if (success) {
    return {
      ok: true,
      data: {
        saveRoll: roll,
        saveTotal: total,
        saveSuccess: true,
        exhaustionApplied: false,
        dc,
      },
      rolls: [formulaRoll],
      mutations: [],
    };
  }

  return {
    ok: true,
    data: {
      saveRoll: roll,
      saveTotal: total,
      saveSuccess: false,
      exhaustionApplied: true,
      dc,
    },
    rolls: [formulaRoll],
    mutations: [
      {
        op: 'add_condition',
        actorId: char.id,
        condition: {
          slug: 'exhaustion',
          source: 'forced march',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ],
  };
}

/**
 * PHB §6.7: starvation. A creature can survive without food for
 * `3 + CON modifier` days (minimum 1). After that threshold, every
 * additional day automatically applies 1 level of exhaustion (no save —
 * the rule says "after that, the character automatically suffers one level
 * of exhaustion at the end of each additional day without food").
 *
 * Within the survival window: no-op. Past the window: emit an
 * `add_condition` exhaustion mutation. Caller passes `daysWithoutFood`
 * (cumulative count for the current bout); the handler computes survival
 * threshold from CON and decides accordingly.
 */
export function handleApplyStarvation(
  state: EngineState,
  input: { actor: string; daysWithoutFood: number },
): ActionResult<{ exhaustionApplied: boolean; survivalDays: number }> {
  const char = state.characters.find((c) => c.id === input.actor);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }

  const conMod = abilityModifier(char.abilities.CON);
  const survivalDays = starvationSurvivalDays(conMod);

  if (input.daysWithoutFood <= survivalDays) {
    return {
      ok: true,
      data: { exhaustionApplied: false, survivalDays },
      rolls: [],
      mutations: [],
    };
  }

  return {
    ok: true,
    data: { exhaustionApplied: true, survivalDays },
    rolls: [],
    mutations: [
      {
        op: 'add_condition',
        actorId: char.id,
        condition: {
          slug: 'exhaustion',
          source: 'starvation',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ],
  };
}

/**
 * PHB §6.7: dehydration. A creature with less than half the daily water
 * requirement must succeed on a CON save at the end of the day or gain
 * 1 level of exhaustion. DC is 15 on the first day and increases by 5
 * for each consecutive day with less than half water.
 *
 * `daysWithLessThanHalfWater < 1` is treated as a no-op (the day hasn't
 * triggered the rule yet — caller's responsibility to count).
 */
export function handleApplyDehydration(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actor: string; daysWithLessThanHalfWater: number },
): ActionResult<{
  saveRoll?: number;
  saveTotal?: number;
  saveSuccess?: boolean;
  exhaustionApplied: boolean;
  dc: number;
}> {
  const char = state.characters.find((c) => c.id === input.actor);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }

  if (input.daysWithLessThanHalfWater < 1) {
    return {
      ok: true,
      data: { exhaustionApplied: false, dc: 0 },
      rolls: [],
      mutations: [],
    };
  }

  const dc = dehydrationSaveDC(input.daysWithLessThanHalfWater);
  const conMod = abilityModifier(char.abilities.CON);
  const profBonus = char.proficiencies.saves.includes('CON') ? char.proficiencyBonus : 0;
  const roll = Math.floor(ctx.rng() * 20) + 1;
  const total = roll + conMod + profBonus;
  const success = total >= dc;

  const formulaRoll: DiceRoll = {
    formula: '1d20+CON',
    rolls: [roll],
    modifier: conMod + profBonus,
    total,
    meta: { kind: 'save', subtype: 'dehydration', dc },
  };

  if (success) {
    return {
      ok: true,
      data: {
        saveRoll: roll,
        saveTotal: total,
        saveSuccess: true,
        exhaustionApplied: false,
        dc,
      },
      rolls: [formulaRoll],
      mutations: [],
    };
  }

  return {
    ok: true,
    data: {
      saveRoll: roll,
      saveTotal: total,
      saveSuccess: false,
      exhaustionApplied: true,
      dc,
    },
    rolls: [formulaRoll],
    mutations: [
      {
        op: 'add_condition',
        actorId: char.id,
        condition: {
          slug: 'exhaustion',
          source: 'dehydration',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ],
  };
}

/**
 * PHB §10.1: attune the PC to a magic item already in their inventory. The
 * engine validates:
 *   - The character exists (`unknown_character`).
 *   - The item is in `inventory` with qty ≥ 1 (`item_not_in_inventory`).
 *   - The PC is not already attuned to it (returns ok with `attuned:false`
 *     and `reason:'already_attuned'`; idempotent, no mutation).
 *   - The cap of 3 (`MAX_ATTUNED`) is not exceeded (`attunement_cap_reached`).
 *
 * The 1-hour bonding ritual itself is narrative — the master narrates the
 * rest and emits this tool call. Prerequisites (class, ability score, race)
 * are NOT enforced by the engine; the master is responsible per plan Task 4.
 */
export function handleAttune(
  state: EngineState,
  input: { character: string; itemSlug: string },
): ActionResult<{ attuned: boolean; reason?: string }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }

  const currentAttuned = char.attunedItems ?? [];

  if (currentAttuned.includes(input.itemSlug)) {
    // Already attuned — return success with attuned:false so the master can
    // narrate "il legame è già forgiato" without a phantom error.
    return {
      ok: true,
      data: { attuned: false, reason: 'already_attuned' },
      rolls: [],
      mutations: [],
    };
  }

  if (currentAttuned.length >= MAX_ATTUNED) {
    return {
      ok: false,
      error: 'attunement_cap_reached',
      rolls: [],
      mutations: [],
    };
  }

  // Must own the item (qty ≥ 1) before attuning. Equipped state is irrelevant.
  const owned = char.inventory.some(
    (i) => i.slug === input.itemSlug && i.qty >= 1,
  );
  if (!owned) {
    return {
      ok: false,
      error: 'item_not_in_inventory',
      rolls: [],
      mutations: [],
    };
  }

  return {
    ok: true,
    data: { attuned: true },
    rolls: [],
    mutations: [
      { op: 'attune', characterId: char.id, itemSlug: input.itemSlug },
    ],
  };
}

/**
 * PHB §10.1: break attunement to a magic item. More permissive than `attune`
 * — if the PC is not currently attuned, returns ok with `unattuned:false`
 * (no error). Used for voluntary unattunement during a long rest, item lost,
 * or when the master wants to cleanly drop a slot.
 */
export function handleUnattune(
  state: EngineState,
  input: { character: string; itemSlug: string },
): ActionResult<{ unattuned: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }

  const currentAttuned = char.attunedItems ?? [];
  if (!currentAttuned.includes(input.itemSlug)) {
    return { ok: true, data: { unattuned: false }, rolls: [], mutations: [] };
  }

  return {
    ok: true,
    data: { unattuned: true },
    rolls: [],
    mutations: [
      { op: 'unattune', characterId: char.id, itemSlug: input.itemSlug },
    ],
  };
}

// ─── Exploration handlers (PHB §6.1, §6.2, §6.4, §6.5, §6.6) ──────────────

const VALID_TRAVEL_PACES: ReadonlySet<TravelPace> = new Set(['fast', 'normal', 'slow']);
const VALID_LIGHT_LEVELS: ReadonlySet<LightLevel> = new Set(['bright', 'dim', 'darkness']);

/**
 * PHB §6.1: set the party's travel pace. Wraps a single set_travel_pace
 * mutation. Returns `invalid_pace` if the input isn't fast/normal/slow.
 */
export function handleSetTravelPace(
  _state: EngineState,
  input: { pace: TravelPace },
): ActionResult<{ pace: TravelPace }> {
  if (!VALID_TRAVEL_PACES.has(input.pace)) {
    return { ok: false, error: 'invalid_pace', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { pace: input.pace },
    rolls: [],
    mutations: [{ op: 'set_travel_pace', pace: input.pace }],
  };
}

/**
 * PHB §6.4: set the ambient light level for the current scene. Returns
 * `invalid_light_level` if the input isn't bright/dim/darkness.
 */
export function handleSetLightLevel(
  _state: EngineState,
  input: { lightLevel: LightLevel },
): ActionResult<{ lightLevel: LightLevel }> {
  if (!VALID_LIGHT_LEVELS.has(input.lightLevel)) {
    return { ok: false, error: 'invalid_light_level', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { lightLevel: input.lightLevel },
    rolls: [],
    mutations: [{ op: 'set_light_level', lightLevel: input.lightLevel }],
  };
}

/**
 * PHB §6.2: set the marching order ranks. Each rank is an array of actor
 * IDs (PC + companions/NPCs). The engine accepts arbitrary IDs — the
 * master is responsible for using consistent identifiers.
 */
export function handleSetMarchingOrder(
  _state: EngineState,
  input: { order: MarchingOrder },
): ActionResult<{ order: MarchingOrder }> {
  if (
    !input.order ||
    typeof input.order !== 'object' ||
    !Array.isArray(input.order.front) ||
    !Array.isArray(input.order.middle) ||
    !Array.isArray(input.order.back)
  ) {
    return { ok: false, error: 'invalid_order', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { order: input.order },
    rolls: [],
    mutations: [{ op: 'set_marching_order', order: input.order }],
  };
}

/**
 * PHB §6.4: assign Senses (darkvision/blindsight/tremorsense/truesight +
 * optional passive Perception override) to a PC or combat actor. The
 * applicator branches PC vs combat-actor by id.
 */
export function handleSetSenses(
  state: EngineState,
  input: { actor: string; senses: Senses },
): ActionResult<{ actor: string; senses: Senses }> {
  const actorId = resolveCharacterId(state, input.actor);
  const isPc = state.characters.some((c) => c.id === actorId);
  const isCombatActor = state.combatActors.some((a) => a.id === actorId);
  if (!isPc && !isCombatActor) {
    return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  }
  if (!input.senses || typeof input.senses !== 'object') {
    return { ok: false, error: 'invalid_senses', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { actor: actorId, senses: input.senses },
    rolls: [],
    mutations: [{ op: 'set_senses', actorId, senses: input.senses }],
  };
}

/**
 * PHB §6.4: pure read-only check of what an observer can perceive at a
 * given distance under the current (or supplied) light level. Returns
 * `canSee/perceptionDisadvantage/effectivelyBlinded/senseUsed`.
 *
 * Sense priority (per PHB):
 *   1. blindsight (in range) — bypasses light entirely
 *   2. tremorsense (in range) — bypasses light entirely
 *   3. truesight (in range) — sees as bright regardless of darkness
 *   4. darkvision + light level — treats dim as bright, darkness as dim
 *   5. plain sight — bound by ambient light
 *
 * If `lightLevel` is omitted, falls back to `state.travel?.lightLevel`
 * else `'bright'`.
 *
 * NO mutation — purely informational. Caller decides how to use the
 * advantage/disadvantage in subsequent rolls (e.g. pass `disadvantage`
 * to `ability_check` for a Perception roll).
 */
export function handleCheckVision(
  state: EngineState,
  input: { observer: string; distanceFt: number; lightLevel?: LightLevel },
): ActionResult<{
  canSee: boolean;
  perceptionDisadvantage: boolean;
  effectivelyBlinded: boolean;
  senseUsed: 'sight' | 'darkvision' | 'blindsight' | 'tremorsense' | 'truesight';
  lightLevel: LightLevel;
}> {
  const observerId = resolveCharacterId(state, input.observer);
  const obs =
    state.characters.find((c) => c.id === observerId) ??
    state.combatActors.find((a) => a.id === observerId);
  if (!obs) {
    return { ok: false, error: 'unknown_observer', rolls: [], mutations: [] };
  }
  if (!Number.isFinite(input.distanceFt) || input.distanceFt < 0) {
    return { ok: false, error: 'invalid_distance', rolls: [], mutations: [] };
  }
  const senses: Senses = obs.senses ?? {};
  const lightLevel: LightLevel =
    input.lightLevel ?? state.travel?.lightLevel ?? 'bright';

  // Blindsight / tremorsense bypass light. Blindsight wins ties since a
  // creature with both can see normally either way; tremorsense requires
  // ground contact (the engine doesn't model that — narrative concern).
  if ((senses.blindsightFt ?? 0) >= input.distanceFt) {
    return {
      ok: true,
      data: {
        canSee: true,
        perceptionDisadvantage: false,
        effectivelyBlinded: false,
        senseUsed: 'blindsight',
        lightLevel,
      },
      rolls: [],
      mutations: [],
    };
  }
  if ((senses.tremorsenseFt ?? 0) >= input.distanceFt) {
    return {
      ok: true,
      data: {
        canSee: true,
        perceptionDisadvantage: false,
        effectivelyBlinded: false,
        senseUsed: 'tremorsense',
        lightLevel,
      },
      rolls: [],
      mutations: [],
    };
  }

  const fx = lightEffects(lightLevel, senses, input.distanceFt);
  // Determine which sense answered: truesight beats darkvision beats sight.
  let senseUsed: 'sight' | 'darkvision' | 'truesight' = 'sight';
  if ((senses.truesightFt ?? 0) >= input.distanceFt) {
    senseUsed = 'truesight';
  } else if ((senses.darkvisionFt ?? 0) >= input.distanceFt && lightLevel !== 'bright') {
    senseUsed = 'darkvision';
  }

  return {
    ok: true,
    data: {
      canSee: !fx.effectivelyBlinded,
      perceptionDisadvantage: fx.perceptionDisadvantage,
      effectivelyBlinded: fx.effectivelyBlinded,
      senseUsed,
      lightLevel,
    },
    rolls: [],
    mutations: [],
  };
}

/**
 * PHB §6.6: a falling creature takes 1d6 bludgeoning per 10 ft (max 20d6)
 * AND lands prone unless negated. The handler rolls the dice and emits
 * `apply_damage` (bludgeoning) + `add_condition` (prone). distanceFt < 10
 * is a no-op (no dice rolled, no prone).
 */
export function handleApplyFalling(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actor: string; distanceFt: number },
): ActionResult<{ damage: number; prone: boolean; dice: number }> {
  const actorId = resolveCharacterId(state, input.actor);
  const target =
    state.characters.find((c) => c.id === actorId) ??
    state.combatActors.find((a) => a.id === actorId);
  if (!target) {
    return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  }
  if (!Number.isFinite(input.distanceFt)) {
    return { ok: false, error: 'invalid_distance', rolls: [], mutations: [] };
  }

  const { dice } = fallingDamageFormula(input.distanceFt);
  if (dice === 0) {
    return {
      ok: true,
      data: { damage: 0, prone: false, dice: 0 },
      rolls: [],
      mutations: [],
    };
  }

  let total = 0;
  const rollValues: number[] = [];
  for (let i = 0; i < dice; i++) {
    const r = Math.floor(ctx.rng() * 6) + 1;
    rollValues.push(r);
    total += r;
  }
  const formulaRoll: DiceRoll = {
    formula: `${dice}d6`,
    rolls: rollValues,
    modifier: 0,
    total,
    meta: { kind: 'damage', subtype: 'falling' },
  };

  return {
    ok: true,
    data: { damage: total, prone: true, dice },
    rolls: [formulaRoll],
    mutations: [
      { op: 'apply_damage', actorId: target.id, amount: total, type: 'bludgeoning' },
      {
        op: 'add_condition',
        actorId: target.id,
        condition: {
          slug: 'prone',
          source: 'falling',
          durationRounds: 'until_removed',
          appliedRound: state.combat?.round ?? 0,
        },
      },
    ],
  };
}

/**
 * PHB §6.5: hold breath = max(30 sec, (1+CON mod)·60 sec). After that, a
 * creature can endure CON mod rounds (min 1) at 0 HP before falling
 * unconscious and beginning to suffocate. The handler categorises the
 * elapsed time:
 *   - status='ok' if within hold-breath window
 *   - status='past_breath' if past hold but within post-breath rounds
 *   - status='unconscious' once both windows are exhausted: emits
 *     set_hp 0 + add_condition unconscious
 *
 * Currently scoped to PCs (the rule applies to creatures generally; the
 * engine only persists the PC's CON and conditions in session_state).
 */
export function handleApplySuffocation(
  state: EngineState,
  input: { actor: string; secondsWithoutAir: number },
): ActionResult<{
  holdBreathSeconds: number;
  postBreathRounds: number;
  status: 'ok' | 'past_breath' | 'unconscious';
}> {
  const actorId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === actorId);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!Number.isFinite(input.secondsWithoutAir) || input.secondsWithoutAir < 0) {
    return { ok: false, error: 'invalid_seconds', rolls: [], mutations: [] };
  }

  const conMod = abilityModifier(char.abilities.CON);
  const { holdBreathSeconds, postBreathRounds } = suffocationSurvival(conMod);
  const postBreathSeconds = postBreathRounds * 6; // 6 sec per combat round (PHB §9)

  if (input.secondsWithoutAir <= holdBreathSeconds) {
    return {
      ok: true,
      data: { holdBreathSeconds, postBreathRounds, status: 'ok' },
      rolls: [],
      mutations: [],
    };
  }

  if (input.secondsWithoutAir <= holdBreathSeconds + postBreathSeconds) {
    return {
      ok: true,
      data: { holdBreathSeconds, postBreathRounds, status: 'past_breath' },
      rolls: [],
      mutations: [],
    };
  }

  // Past both windows → drop to 0 HP and unconscious. The PC enters the
  // dying state; the master is responsible for narrating subsequent ticks
  // (instant death after 5 rounds of full suffocation per PHB §6.5).
  return {
    ok: true,
    data: { holdBreathSeconds, postBreathRounds, status: 'unconscious' },
    rolls: [],
    mutations: [
      { op: 'set_hp', actorId: char.id, hpCurrent: 0 },
      {
        op: 'add_condition',
        actorId: char.id,
        condition: {
          slug: 'unconscious',
          source: 'suffocation',
          durationRounds: 'until_removed',
          appliedRound: state.combat?.round ?? 0,
        },
      },
    ],
  };
}

function resolveCharacterId(state: EngineState, actorRef: unknown): string {
  if (typeof actorRef === 'string' && actorRef === 'player_character' && state.characters.length === 1) {
    return state.characters[0]!.id;
  }
  return String(actorRef);
}

// ─── NPC Three-Beat / Tonal Frame / Engagement Profile (Phase 7) ──────────

/**
 * Master World Lore §5.1: pin the campaign's tonal frame. The frame
 * shapes narration style, NPC speech register, combat consequences, and
 * magic flavor for every subsequent turn. The system prompt's dynamic
 * block surfaces `TONAL_FRAME_GUIDANCE[frame]` once this is set.
 *
 * Errors with `invalid_tonal_frame` if the value isn't one of the 8
 * canonical frames.
 */
export function handleSetTonalFrame(
  input: { frame: TonalFrame },
): ActionResult<{ frame: TonalFrame }> {
  if (typeof input.frame !== 'string' || !isValidTonalFrame(input.frame)) {
    return { ok: false, error: 'invalid_tonal_frame', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { frame: input.frame },
    rolls: [],
    mutations: [{ op: 'set_tonal_frame', frame: input.frame }],
  };
}

/**
 * Master Handbook §2.1: register the player's engagement profile(s) the
 * master has detected from the first few turns. Multiple values are
 * legal — a single player can be both an explorer and a storyteller.
 * Empty array clears the hint.
 *
 * Errors with `invalid_engagement_profile` if ANY entry isn't one of
 * the 7 canonical profiles. The handler does NOT silently drop bad
 * entries — the AI Master must call again with a fully-valid array.
 */
export function handleSetEngagementProfile(
  input: { profiles: string[] },
): ActionResult<{ profiles: EngagementProfile[] }> {
  if (!Array.isArray(input.profiles)) {
    return { ok: false, error: 'invalid_engagement_profile', rolls: [], mutations: [] };
  }
  for (const profile of input.profiles) {
    if (typeof profile !== 'string' || !isValidEngagementProfile(profile)) {
      return { ok: false, error: 'invalid_engagement_profile', rolls: [], mutations: [] };
    }
  }
  // Cast is safe — every entry passed isValidEngagementProfile above.
  const profiles = input.profiles as EngagementProfile[];
  return {
    ok: true,
    data: { profiles },
    rolls: [],
    mutations: [{ op: 'set_engagement_profile', profiles }],
  };
}

/**
 * Master Handbook §11.1: partial update of an NPC codex entry's
 * Want/Fear/Quirk/Attitude. The applicator merges with existing values —
 * fields not present in `beats` stay untouched. The npcSlug must point to
 * an existing codex_entities row (kind='npc'); the engine itself does NOT
 * verify existence (the applicator's UPDATE matches by (sessionId, kind,
 * slug) and is a silent no-op if no match).
 *
 * Errors:
 * - `missing_npc_slug` — empty/whitespace slug.
 * - `invalid_attitude` — attitude is provided but not friendly/indifferent/hostile.
 */
export function handleUpdateNPCBeats(
  input: { npcSlug: string; beats: Partial<NPCBeats> },
): ActionResult<{ npcSlug: string; beats: Partial<NPCBeats> }> {
  if (typeof input.npcSlug !== 'string' || !input.npcSlug.trim()) {
    return { ok: false, error: 'missing_npc_slug', rolls: [], mutations: [] };
  }
  const beats = input.beats ?? {};
  if (beats.attitude != null && !isValidNPCAttitude(beats.attitude)) {
    return { ok: false, error: 'invalid_attitude', rolls: [], mutations: [] };
  }
  // Filter the patch to legal fields and trim string values defensively.
  const cleaned: NPCBeats = {};
  if (typeof beats.want === 'string') cleaned.want = beats.want;
  if (typeof beats.fear === 'string') cleaned.fear = beats.fear;
  if (typeof beats.quirk === 'string') cleaned.quirk = beats.quirk;
  if (beats.attitude != null) cleaned.attitude = beats.attitude;
  return {
    ok: true,
    data: { npcSlug: input.npcSlug, beats: cleaned },
    rolls: [],
    mutations: [{ op: 'update_npc_beats', npcSlug: input.npcSlug, beats: cleaned }],
  };
}

import { lookupCodex } from './lookup-codex';
import { lookupSpellMeta } from '@/srd/lookup';

export interface DbToolCtx {
  sessionId: string;
}

export type DbToolHandler = (
  ctx: DbToolCtx,
  state: EngineState,
  input: Record<string, unknown>,
) => Promise<import('../types').ActionResult>;

export const TOOL_HANDLERS_DB: Record<string, DbToolHandler> = {
  // lookup_codex doesn't need state, ignore the second arg.
  lookup_codex: (ctx, _state, input) => lookupCodex(ctx, input),

  long_rest: async (ctx, state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) {
      return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    }

    // PHB §5.2: read the persisted `last_long_rest_at` from session_state
    // so we can enforce the 24h cooldown. NULL → no cooldown to enforce.
    const { db } = await import('@/db/client');
    const { sessionState } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ lastLongRestAt: sessionState.lastLongRestAt })
      .from(sessionState)
      .where(eq(sessionState.sessionId, ctx.sessionId))
      .limit(1);
    const lastLongRestAtMs = row?.lastLongRestAt
      ? row.lastLongRestAt.getTime()
      : undefined;

    const interruptedByMinutesRaw = input.interruptedByMinutes;
    const interruptedByMinutes =
      typeof interruptedByMinutesRaw === 'number' && Number.isFinite(interruptedByMinutesRaw)
        ? Math.max(0, Math.floor(interruptedByMinutesRaw))
        : undefined;

    return longRest({
      char,
      runtime,
      lastLongRestAtMs,
      currentEpochMs: Date.now(),
      interruptedByMinutes,
    });
  },

  cast_spell: async (_ctx, state, input) => {
    const casterId = resolveCharacterId(state, input.caster);
    const caster = state.characters.find((c) => c.id === casterId);
    const runtime = state.runtime[casterId];
    if (!caster || !runtime) {
      return { ok: false, error: 'unknown_caster', rolls: [], mutations: [] };
    }

    const spellSlug = String(input.spellSlug);
    const slotLevel = Number(input.slotLevel) as 0|1|2|3|4|5|6|7|8|9;
    const targets = ((input.targets as { id: string }[]) ?? []).map((t) => ({ id: String(t.id) }));
    const asRitual = input.asRitual === true;

    // Always fetch spellMeta from the SRD: castSpell now uses `castingTime` to
    // drive action-economy consumption (PHB §3.9 + §8.5), in addition to the
    // ritual flag check for `asRitual` casts. Falls back to `undefined` if the
    // spell isn't in the SRD — castSpell will assume '1 action' in that case.
    const spellMeta = await lookupSpellMeta(spellSlug);

    return castSpell({
      caster,
      runtime,
      spellSlug,
      slotLevel,
      targets,
      currentRound: state.combat?.round ?? 0,
      asRitual,
      spellMeta,
    });
  },
};
