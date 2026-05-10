import type {
  ActionResult,
  Bastion,
  BastionFortification,
  BastionRoom,
  BastionRoomKind,
  CraftingKind,
  CraftingProject,
  DiceRoll,
  DowntimeActivity,
  DowntimeActivityKind,
  EngagementProfile,
  EngineState,
  EquippedFocus,
  FocusKind,
  Hireling,
  LightLevel,
  MarchingOrder,
  MountedState,
  MountMode,
  Mutation,
  NPCBeats,
  Senses,
  TonalFrame,
  TravelPace,
} from '../types';
import {
  canBeMount,
  isValidMountMode,
} from '../mounts';
import { isValidVehicleSlug } from '../vehicles';
import {
  isValidCraftingKind,
  isValidCraftableRarity,
  magicItemCraftingRequirements,
  nonMagicalCraftingRequirements,
  potionCraftingRequirements,
  scrollCraftingRequirements,
  type CraftableRarity,
  type CraftingRequirements,
  type CraftingSpellLevel,
} from '../crafting';
import {
  buildDefaultBastion,
  downtimeRequirements,
  hirelingTotalCost,
  isValidBastionFortification,
  isValidBastionRoomKind,
  isValidDowntimeActivityKind,
} from '../downtime';
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
  meetsMulticlassPrereqs,
  VALID_CLASS_SLUGS,
} from '../multiclass';
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
      cover: typeof input.cover === 'string' ? (input.cover as never) : undefined,
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
        properties: Array.isArray(weaponInput.properties)
          ? (weaponInput.properties as unknown[]).filter(
              (p): p is string => typeof p === 'string',
            )
          : undefined,
        ammoSlug:
          typeof weaponInput.ammoSlug === 'string' ? weaponInput.ammoSlug : undefined,
        range:
          weaponInput.range && typeof weaponInput.range === 'object'
            ? {
                normal: Number((weaponInput.range as { normal?: unknown }).normal ?? 0),
                long: Number((weaponInput.range as { long?: unknown }).long ?? 0),
              }
            : undefined,
      },
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
      attackerRuntime,
      targetRuntime,
      ranged: input.ranged === true,
      meleeRange: typeof input.meleeRange === 'number' ? input.meleeRange : undefined,
      knockOut: input.knockOut === true,
      useInspiration: input.useInspiration === true,
      cover: typeof input.cover === 'string' ? (input.cover as never) : undefined,
      offHand: input.offHand === true,
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

  // PHB §2.5 Multiclassing: add (or re-level) one level of a class. The
  // engine validates the class slug against the canonical 12-PHB list
  // and the multiclass ability prerequisites for both the starting
  // class and the target class. Re-leveling an existing class skips
  // the prereq gate (the PC already has that class). Subclass is
  // optional but, when supplied, is persisted on the entry — the
  // master uses it to drive Eldritch Knight / Arcane Trickster
  // third-caster spell-slot calculations.
  add_class_level: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    const charId = resolveCharacterId(state, ref);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };

    const slug = typeof input.classSlug === 'string' ? input.classSlug.trim().toLowerCase() : '';
    if (!slug || !VALID_CLASS_SLUGS.includes(slug)) {
      return { ok: false, error: 'invalid_class_slug', rolls: [], mutations: [] };
    }

    if (!meetsMulticlassPrereqs(char, slug)) {
      return { ok: false, error: 'multiclass_prereqs_not_met', rolls: [], mutations: [] };
    }

    const subclass =
      typeof input.subclass === 'string' && input.subclass.trim()
        ? input.subclass.trim().toLowerCase()
        : undefined;

    return {
      ok: true,
      rolls: [],
      mutations: [
        {
          op: 'add_class_level',
          characterId: char.id,
          classSlug: slug,
          ...(subclass ? { subclass } : {}),
        },
      ],
      data: { added: true, classSlug: slug, subclass },
    };
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

  equip_focus: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    const kind = input.kind as string;
    const slug = String(input.itemSlug ?? '').trim().toLowerCase();
    if (!slug) {
      return { ok: false, error: 'invalid_slug', rolls: [], mutations: [] };
    }
    return handleEquipFocus(state, {
      character: charId,
      kind: kind as FocusKind,
      itemSlug: slug,
    });
  },

  unequip_focus: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleUnequipFocus(state, { character: charId });
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

  // Phase 11 — class features wiring.
  use_class_feature: (state, input) => {
    return handleUseClassFeature(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
      featureSlug: String(input.featureSlug ?? ''),
      uses: typeof input.uses === 'number' ? input.uses : undefined,
    });
  },

  start_rage: (state, input) => {
    return handleStartRage(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
    });
  },

  end_rage: (state, input) => {
    return handleEndRage(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
    });
  },

  use_action_surge: (state, input) => {
    return handleUseActionSurge(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
    });
  },

  use_channel_divinity: (state, input) => {
    return handleUseChannelDivinity(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
      effect: typeof input.effect === 'string' ? input.effect : undefined,
    });
  },

  grant_bardic_inspiration: (state, input) => {
    return handleGrantBardicInspiration(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
      targetId: String(input.targetId ?? input.target ?? ''),
      dieSize: typeof input.dieSize === 'number' ? input.dieSize : undefined,
    });
  },

  use_lay_on_hands: (state, input) => {
    return handleUseLayOnHands(state, {
      actor: String(input.actor ?? input.actorId ?? ''),
      targetId: String(input.targetId ?? input.target ?? ''),
      points: typeof input.points === 'number' ? input.points : undefined,
      curePoison: input.curePoison === true,
    });
  },

  // Phase 12 — crafting (PHB §5 + DMG)
  start_crafting: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleStartCrafting(state, {
      character: charId,
      recipeSlug: typeof input.recipeSlug === 'string' ? input.recipeSlug : '',
      kind: input.kind as CraftingKind,
      itemPriceGp: typeof input.itemPriceGp === 'number' ? input.itemPriceGp : undefined,
      rarity:
        typeof input.rarity === 'string' ? (input.rarity as CraftableRarity) : undefined,
      spellLevel:
        typeof input.spellLevel === 'number' ? (input.spellLevel as CraftingSpellLevel) : undefined,
      projectId: typeof input.projectId === 'string' ? input.projectId : undefined,
      startedRound:
        typeof input.startedRound === 'number' ? input.startedRound : undefined,
    });
  },

  progress_crafting: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleProgressCrafting(state, {
      character: charId,
      projectId: typeof input.projectId === 'string' ? input.projectId : '',
      daysSpent: typeof input.daysSpent === 'number' ? input.daysSpent : 0,
      gpDelta: typeof input.gpDelta === 'number' ? input.gpDelta : undefined,
    });
  },

  complete_crafting: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleCompleteCrafting(state, {
      character: charId,
      projectId: typeof input.projectId === 'string' ? input.projectId : '',
    });
  },

  cancel_crafting: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleCancelCrafting(state, {
      character: charId,
      projectId: typeof input.projectId === 'string' ? input.projectId : '',
    });
  },

  // ── Phase 13: downtime / hirelings / bastion (PHB §6 + 2024 PHB) ──
  start_downtime_activity: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleStartDowntimeActivity(state, {
      character: charId,
      activity: input.activity as DowntimeActivityKind,
      days: typeof input.days === 'number' ? input.days : undefined,
      activityId: typeof input.activityId === 'string' ? input.activityId : undefined,
      startedAt: typeof input.startedAt === 'number' ? input.startedAt : undefined,
    });
  },

  complete_downtime_activity: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleCompleteDowntimeActivity(state, {
      character: charId,
      activityId: typeof input.activityId === 'string' ? input.activityId : '',
    });
  },

  hire: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleHire(state, {
      character: charId,
      kind: input.kind as 'skilled' | 'unskilled',
      count: typeof input.count === 'number' ? input.count : 0,
      days: typeof input.days === 'number' ? input.days : 0,
      hireId: typeof input.hireId === 'string' ? input.hireId : undefined,
      startedAt: typeof input.startedAt === 'number' ? input.startedAt : undefined,
    });
  },

  dismiss_hireling: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleDismissHireling(state, {
      character: charId,
      hireId: typeof input.hireId === 'string' ? input.hireId : '',
    });
  },

  set_bastion: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleSetBastion(state, {
      character: charId,
      name: typeof input.name === 'string' ? input.name : '',
      fortification: input.fortification as BastionFortification,
    });
  },

  add_bastion_room: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleAddBastionRoom(state, {
      character: charId,
      kind: input.kind as BastionRoomKind,
      level: typeof input.level === 'number' ? input.level : undefined,
    });
  },

  // ── Phase 14: mounted combat / vehicles (PHB §3.23, §9.6) ──
  mount: (state, input) => {
    const riderRef = input.rider ?? input.character ?? input.actor;
    if (riderRef == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const riderId = resolveCharacterId(state, riderRef);
    return handleMount(state, {
      rider: riderId,
      mount: typeof input.mount === 'string' ? input.mount : '',
      mode: typeof input.mode === 'string' ? (input.mode as MountMode) : undefined,
    });
  },

  dismount: (state, input) => {
    const riderRef = input.rider ?? input.character ?? input.actor;
    if (riderRef == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const riderId = resolveCharacterId(state, riderRef);
    return handleDismount(state, { rider: riderId });
  },

  set_mount_mode: (state, input) => {
    const riderRef = input.rider ?? input.character ?? input.actor;
    if (riderRef == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const riderId = resolveCharacterId(state, riderRef);
    return handleSetMountMode(state, {
      rider: riderId,
      mode: input.mode as MountMode,
    });
  },

  embark_vehicle: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleEmbarkVehicle(state, {
      character: charId,
      vehicleSlug: typeof input.vehicleSlug === 'string' ? input.vehicleSlug : '',
    });
  },

  disembark_vehicle: (state, input) => {
    const ref = input.character ?? input.actor;
    if (ref == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const charId = resolveCharacterId(state, ref);
    return handleDisembarkVehicle(state, { character: charId });
  },

  swap_attack_target: (state, input) => {
    const riderRef = input.rider ?? input.character ?? input.actor;
    if (riderRef == null) {
      return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
    }
    const riderId = resolveCharacterId(state, riderRef);
    return handleSwapAttackTarget(state, {
      rider: riderId,
      originalTargetId:
        typeof input.originalTargetId === 'string' ? input.originalTargetId : '',
      newTargetId:
        typeof input.newTargetId === 'string' ? input.newTargetId : '',
    });
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
 * PHB §8.4 — equip a spellcasting focus. Validates:
 *   - The character exists (`unknown_character`).
 *   - `kind` is one of arcane/druidic/holy/instrument (`invalid_focus_kind`).
 *   - `itemSlug` is in inventory (`item_not_in_inventory`).
 *
 * Class-vs-kind matching is NOT enforced here: a non-caster fighter may
 * carry an arcane orb (it just won't satisfy components at cast time
 * because focusKindForClass returns null). This permissive policy keeps
 * the tool usable for narrative scenes (e.g. carrying a focus for a
 * sleeping ally).
 */
const VALID_FOCUS_KINDS: ReadonlySet<FocusKind> = new Set([
  'arcane',
  'druidic',
  'holy',
  'instrument',
]);

export function handleEquipFocus(
  state: EngineState,
  input: { character: string; kind: FocusKind; itemSlug: string },
): ActionResult<{ equipped: boolean; focus: EquippedFocus }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (typeof input.kind !== 'string' || !VALID_FOCUS_KINDS.has(input.kind)) {
    return { ok: false, error: 'invalid_focus_kind', rolls: [], mutations: [] };
  }
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
  const focus: EquippedFocus = { kind: input.kind, itemSlug: input.itemSlug };
  return {
    ok: true,
    data: { equipped: true, focus },
    rolls: [],
    mutations: [{ op: 'set_focus', characterId: char.id, focus }],
  };
}

/**
 * PHB §8.4 — drop the currently held focus. Idempotent: when no focus
 * is set, returns ok with `unequipped:false` (no mutation).
 */
export function handleUnequipFocus(
  state: EngineState,
  input: { character: string },
): ActionResult<{ unequipped: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!char.equippedFocus) {
    return { ok: true, data: { unequipped: false }, rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { unequipped: true },
    rolls: [],
    mutations: [{ op: 'unset_focus', characterId: char.id }],
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

// ─── Phase 11 — Class Features (PHB §10) ─────────────────────────────────
//
// 6 dedicated handlers + 1 generic. Each validates the feature exists on
// the actor, that uses-remaining permits the call, and emits the right
// mutations. All are pure (no DB) so the AI master tool loop can drive
// them deterministically.

import {
  bardicInspirationDie,
  classLevel,
  layOnHandsPool,
} from '../class-features';

/**
 * Resolve the FeatureInstance + uses-remaining for a (character, slug)
 * pair. Returns null when the feature isn't on the character.
 */
function resolveFeature(
  state: EngineState,
  characterId: string,
  featureSlug: string,
): { usesMax: number | 'unlimited'; used: number; remaining: number } | null {
  const char = state.characters.find((c) => c.id === characterId);
  if (!char) return null;
  const f = char.features.find((feat) => feat.slug === featureSlug);
  if (!f) return null;
  const used = state.runtime[characterId]?.resourcesUsed?.[featureSlug] ?? 0;
  const remaining =
    f.usesMax === 'unlimited' ? Number.POSITIVE_INFINITY : Math.max(0, f.usesMax - used);
  return { usesMax: f.usesMax, used, remaining };
}

/**
 * Generic class-feature consumption. Validates the feature exists on the
 * character and has enough uses remaining; emits a use_class_feature
 * mutation. For specific features (rage, lay on hands) the dedicated
 * handlers are preferred — they layer additional state changes on top.
 *
 * Errors:
 * - `unknown_actor` — the actor id is not a known character.
 * - `feature_not_found` — the character does not have the feature.
 * - `no_uses_remaining` — uses-remaining < requested uses.
 */
export function handleUseClassFeature(
  state: EngineState,
  input: { actor: string; featureSlug: string; uses?: number },
): ActionResult<{ featureSlug: string; usesConsumed: number; remainingAfter: number }> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const slug = String(input.featureSlug || '').trim();
  if (!slug) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  const info = resolveFeature(state, charId, slug);
  if (!info) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  const uses = Math.max(1, Math.floor(input.uses ?? 1));
  if (info.remaining < uses) {
    return { ok: false, error: 'no_uses_remaining', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: {
      featureSlug: slug,
      usesConsumed: uses,
      remainingAfter: info.remaining === Number.POSITIVE_INFINITY ? Infinity : info.remaining - uses,
    },
    rolls: [],
    mutations: [{ op: 'use_class_feature', actorId: char.id, featureSlug: slug, uses }],
  };
}

/**
 * PHB Barbarian: enter Rage. Validates the actor has the rage feature with
 * uses remaining and at least 1 barbarian level. Emits use_class_feature
 * + add_condition('raging', 10 rounds). The combat layer reads the
 * 'raging' condition for damage bonus / resistance / STR ADV; the
 * resourcesUsed counter tracks per-day uses (recharged on long rest).
 *
 * Errors:
 * - `unknown_actor`, `feature_not_found`, `no_uses_remaining` — same as
 *   handleUseClassFeature.
 * - `not_barbarian` — actor has no levels in the barbarian class.
 */
export function handleStartRage(
  state: EngineState,
  input: { actor: string },
): ActionResult<{ barbLevel: number; durationRounds: number }> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const barbLevel = classLevel(char, 'barbarian');
  if (barbLevel < 1) {
    return { ok: false, error: 'not_barbarian', rolls: [], mutations: [] };
  }
  const info = resolveFeature(state, charId, 'rage');
  if (!info) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  if (info.remaining < 1) {
    return { ok: false, error: 'no_uses_remaining', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { barbLevel, durationRounds: 10 },
    rolls: [],
    mutations: [
      { op: 'use_class_feature', actorId: char.id, featureSlug: 'rage', uses: 1 },
      {
        op: 'add_condition',
        actorId: char.id,
        condition: {
          slug: 'raging',
          source: 'rage',
          durationRounds: 10,
          appliedRound: state.combat?.round ?? 0,
        },
      },
    ],
  };
}

/**
 * PHB Barbarian: end Rage manually before its 10-round duration expires.
 * Idempotent: returns ok:true with no mutations when the actor isn't
 * currently raging.
 */
export function handleEndRage(
  state: EngineState,
  input: { actor: string },
): ActionResult<{ wasRaging: boolean }> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const rt = state.runtime[charId];
  const wasRaging = (rt?.conditions ?? []).some((c) => c.slug === 'raging');
  if (!wasRaging) {
    return { ok: true, data: { wasRaging: false }, rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { wasRaging: true },
    rolls: [],
    mutations: [{ op: 'remove_condition', actorId: char.id, conditionSlug: 'raging' }],
  };
}

/**
 * PHB Fighter: Action Surge. Validates the actor is a fighter L2+ with the
 * action_surge feature and uses remaining. Emits use_class_feature +
 * reset_action_for_surge (clears turnState.actionUsed so the fighter can
 * take another action this turn). Bonus action and reaction are NOT
 * touched.
 *
 * Errors:
 * - `unknown_actor`, `feature_not_found`, `no_uses_remaining`.
 * - `not_fighter` — actor has no fighter levels.
 */
export function handleUseActionSurge(
  state: EngineState,
  input: { actor: string },
): ActionResult<{ fighterLevel: number }> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const fighterLevel = classLevel(char, 'fighter');
  if (fighterLevel < 1) {
    return { ok: false, error: 'not_fighter', rolls: [], mutations: [] };
  }
  const info = resolveFeature(state, charId, 'action_surge');
  if (!info) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  if (info.remaining < 1) {
    return { ok: false, error: 'no_uses_remaining', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { fighterLevel },
    rolls: [],
    mutations: [
      { op: 'use_class_feature', actorId: char.id, featureSlug: 'action_surge', uses: 1 },
      { op: 'reset_action_for_surge', actorId: char.id },
    ],
  };
}

/**
 * PHB Cleric/Paladin: Channel Divinity. Validates the actor is a cleric
 * or paladin with the channel_divinity feature and uses remaining.
 * `effect` is a narrative string (turn_undead, sacred_weapon, etc.) —
 * the engine consumes the use only; the actual mechanical consequence
 * is up to the master to follow up with the appropriate tool calls
 * (e.g. add_condition('sacred_weapon') for Sacred Weapon).
 *
 * Errors:
 * - `unknown_actor`, `feature_not_found`, `no_uses_remaining`.
 * - `not_cleric_or_paladin` — actor has no cleric/paladin levels.
 */
export function handleUseChannelDivinity(
  state: EngineState,
  input: { actor: string; effect?: string },
): ActionResult<{ effect: string; classSlug: 'cleric' | 'paladin' }> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const clericLevel = classLevel(char, 'cleric');
  const paladinLevel = classLevel(char, 'paladin');
  if (clericLevel < 1 && paladinLevel < 1) {
    return { ok: false, error: 'not_cleric_or_paladin', rolls: [], mutations: [] };
  }
  const info = resolveFeature(state, charId, 'channel_divinity');
  if (!info) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  if (info.remaining < 1) {
    return { ok: false, error: 'no_uses_remaining', rolls: [], mutations: [] };
  }
  // Pick the higher-level class as the "primary" for narrative purposes.
  const classSlug: 'cleric' | 'paladin' = clericLevel >= paladinLevel ? 'cleric' : 'paladin';
  const effect = String(input.effect ?? '').trim() || 'unspecified';
  return {
    ok: true,
    data: { effect, classSlug },
    rolls: [],
    mutations: [
      { op: 'use_class_feature', actorId: char.id, featureSlug: 'channel_divinity', uses: 1 },
    ],
  };
}

/**
 * PHB Bard: grant Bardic Inspiration to an ally. Validates the actor is a
 * bard L1+ with the bardic_inspiration feature and uses remaining.
 * Computes the die size from the bard's level if not supplied. Emits
 * use_class_feature + add_condition('bardic_inspired') on the target with
 * the die size encoded in `source` (e.g. "bardic_inspiration:d8") so the
 * snapshot/UI can surface it.
 *
 * Errors:
 * - `unknown_actor`, `feature_not_found`, `no_uses_remaining`.
 * - `not_bard` — actor has no bard levels.
 * - `unknown_target` — the target id is not a known character/combat actor.
 * - `invalid_die_size` — explicit dieSize is not 6/8/10/12.
 */
export function handleGrantBardicInspiration(
  state: EngineState,
  input: { actor: string; targetId: string; dieSize?: number },
): ActionResult<{ bardLevel: number; dieSize: 6 | 8 | 10 | 12 }> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const bardLevel = classLevel(char, 'bard');
  if (bardLevel < 1) {
    return { ok: false, error: 'not_bard', rolls: [], mutations: [] };
  }
  const info = resolveFeature(state, charId, 'bardic_inspiration');
  if (!info) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  if (info.remaining < 1) {
    return { ok: false, error: 'no_uses_remaining', rolls: [], mutations: [] };
  }
  const targetId = String(input.targetId ?? '').trim();
  if (!targetId) {
    return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
  }
  const targetExists =
    state.characters.some((c) => c.id === targetId) ||
    state.combatActors.some((a) => a.id === targetId);
  if (!targetExists) {
    return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
  }
  let dieSize: 6 | 8 | 10 | 12;
  if (input.dieSize == null) {
    dieSize = bardicInspirationDie(bardLevel);
  } else {
    if (input.dieSize !== 6 && input.dieSize !== 8 && input.dieSize !== 10 && input.dieSize !== 12) {
      return { ok: false, error: 'invalid_die_size', rolls: [], mutations: [] };
    }
    dieSize = input.dieSize;
  }
  return {
    ok: true,
    data: { bardLevel, dieSize },
    rolls: [],
    mutations: [
      { op: 'use_class_feature', actorId: char.id, featureSlug: 'bardic_inspiration', uses: 1 },
      {
        op: 'add_condition',
        actorId: targetId,
        condition: {
          slug: 'bardic_inspired',
          source: `bardic_inspiration:d${dieSize}`,
          // PHB Bardic Inspiration: lasts 10 minutes (100 combat rounds at 6sec/round).
          // We use 100 as a practical proxy; the master may remove it manually.
          durationRounds: 100,
          appliedRound: state.combat?.round ?? 0,
        },
      },
    ],
  };
}

/**
 * PHB Paladin: Lay on Hands. Validates the actor is a paladin L1+ with
 * the lay_on_hands feature and a sufficient pool. The pool is
 * 5 × paladin_level; the spent counter lives at
 * runtime.resourcesUsed['lay_on_hands']. `points` are added to the target's
 * HP; `curePoison: true` costs a flat 5 from the pool AND removes the
 * 'poisoned' condition from the target.
 *
 * Both actions can be combined in a single call as long as
 * `points + (curePoison ? 5 : 0) <= remaining`.
 *
 * Errors:
 * - `unknown_actor`, `feature_not_found`.
 * - `not_paladin` — actor has no paladin levels.
 * - `unknown_target` — target id not found.
 * - `invalid_points` — points < 0.
 * - `nothing_to_do` — points is 0 and curePoison is false.
 * - `insufficient_pool` — total cost exceeds remaining pool.
 */
export function handleUseLayOnHands(
  state: EngineState,
  input: { actor: string; targetId: string; points?: number; curePoison?: boolean },
): ActionResult<{
  paladinLevel: number;
  pointsHealed: number;
  curedPoison: boolean;
  poolBefore: number;
  poolAfter: number;
}> {
  const charId = resolveCharacterId(state, input.actor);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  const paladinLevel = classLevel(char, 'paladin');
  if (paladinLevel < 1) {
    return { ok: false, error: 'not_paladin', rolls: [], mutations: [] };
  }
  const info = resolveFeature(state, charId, 'lay_on_hands');
  if (!info) return { ok: false, error: 'feature_not_found', rolls: [], mutations: [] };
  const targetId = String(input.targetId ?? '').trim();
  if (!targetId) {
    return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
  }
  const targetExists =
    state.characters.some((c) => c.id === targetId) ||
    state.combatActors.some((a) => a.id === targetId);
  if (!targetExists) {
    return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
  }
  const points = Math.floor(input.points ?? 0);
  if (points < 0) {
    return { ok: false, error: 'invalid_points', rolls: [], mutations: [] };
  }
  const curePoison = input.curePoison === true;
  if (points === 0 && !curePoison) {
    return { ok: false, error: 'nothing_to_do', rolls: [], mutations: [] };
  }
  const pool = layOnHandsPool(paladinLevel);
  const spent = state.runtime[charId]?.resourcesUsed?.['lay_on_hands'] ?? 0;
  const remaining = pool - spent;
  const cost = points + (curePoison ? 5 : 0);
  if (cost > remaining) {
    return { ok: false, error: 'insufficient_pool', rolls: [], mutations: [] };
  }
  const muts: Mutation[] = [];
  if (points > 0) {
    muts.push({ op: 'heal', actorId: targetId, amount: points });
  }
  if (curePoison) {
    muts.push({ op: 'remove_condition', actorId: targetId, conditionSlug: 'poisoned' });
  }
  // Track spent pool. We use modify_lay_on_hands_pool for a clear log entry.
  muts.push({ op: 'modify_lay_on_hands_pool', actorId: char.id, delta: cost });
  return {
    ok: true,
    data: {
      paladinLevel,
      pointsHealed: points,
      curedPoison: curePoison,
      poolBefore: remaining,
      poolAfter: remaining - cost,
    },
    rolls: [],
    mutations: muts,
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

// ─── Crafting (PHB §5 + DMG, Phase 12) ─────────────────────────────────────

/**
 * Compute the crafting requirements for a given kind. Branches on
 * `kind` and validates the kind-specific input is present + sane.
 * Returns a discriminated result so callers can surface a tool error
 * instead of throwing.
 */
function computeCraftingRequirements(input: {
  kind: CraftingKind;
  itemPriceGp?: number;
  rarity?: CraftableRarity;
  spellLevel?: CraftingSpellLevel;
}):
  | { ok: true; req: CraftingRequirements }
  | { ok: false; error: string } {
  switch (input.kind) {
    case 'item': {
      const price = input.itemPriceGp ?? 0;
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
        return { ok: false, error: 'invalid_item_price' };
      }
      return { ok: true, req: nonMagicalCraftingRequirements(price) };
    }
    case 'magic_item': {
      if (!isValidCraftableRarity(input.rarity)) {
        return { ok: false, error: 'invalid_rarity' };
      }
      return { ok: true, req: magicItemCraftingRequirements(input.rarity) };
    }
    case 'scroll': {
      const lvl = input.spellLevel;
      if (typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 0 || lvl > 9) {
        return { ok: false, error: 'invalid_spell_level' };
      }
      return { ok: true, req: scrollCraftingRequirements(lvl as CraftingSpellLevel) };
    }
    case 'potion': {
      // Potion accepts spell level 0 by default (treated as common).
      const lvl = input.spellLevel ?? 0;
      if (typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 0 || lvl > 9) {
        return { ok: false, error: 'invalid_spell_level' };
      }
      return { ok: true, req: potionCraftingRequirements(lvl as CraftingSpellLevel) };
    }
  }
}

/** Generate a unique-enough project id without depending on crypto APIs. */
function generateProjectId(recipeSlug: string): string {
  const cryptoApi: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined'
      ? ((globalThis as { crypto?: { randomUUID?: () => string } }).crypto ?? undefined)
      : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  // Fallback: slug + timestamp + random suffix. Good enough for tests/dev
  // where crypto.randomUUID is missing; the applicator is idempotent on
  // duplicate ids so collisions don't corrupt state.
  const ts = Date.now().toString(36);
  const rnd = Math.floor(Math.random() * 1_000_000).toString(36);
  return `${recipeSlug || 'project'}-${ts}-${rnd}`;
}

/**
 * PHB §5 + DMG: kick off a crafting project. Validates the kind and the
 * kind-specific inputs, computes the requirements, generates a project
 * id, and emits `start_crafting`.
 *
 * Errors:
 *   - `unknown_character` — character not found.
 *   - `invalid_recipe_slug` — empty/whitespace-only slug.
 *   - `invalid_kind` — kind not in {item, magic_item, scroll, potion}.
 *   - `invalid_item_price` / `invalid_rarity` / `invalid_spell_level`
 *     — kind-specific input missing or out of range.
 */
export function handleStartCrafting(
  state: EngineState,
  input: {
    character: string;
    recipeSlug: string;
    kind: CraftingKind;
    itemPriceGp?: number;
    rarity?: CraftableRarity;
    spellLevel?: CraftingSpellLevel;
    projectId?: string;
    startedRound?: number;
  },
): ActionResult<{ project: CraftingProject }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const recipeSlug = (input.recipeSlug ?? '').trim().toLowerCase();
  if (!recipeSlug) {
    return { ok: false, error: 'invalid_recipe_slug', rolls: [], mutations: [] };
  }
  if (!isValidCraftingKind(input.kind)) {
    return { ok: false, error: 'invalid_kind', rolls: [], mutations: [] };
  }

  const reqRes = computeCraftingRequirements({
    kind: input.kind,
    itemPriceGp: input.itemPriceGp,
    rarity: input.rarity,
    spellLevel: input.spellLevel,
  });
  if (!reqRes.ok) {
    return { ok: false, error: reqRes.error, rolls: [], mutations: [] };
  }

  const project: CraftingProject = {
    id:
      typeof input.projectId === 'string' && input.projectId.trim()
        ? input.projectId.trim()
        : generateProjectId(recipeSlug),
    recipeSlug,
    kind: input.kind,
    daysRemaining: reqRes.req.daysRequired,
    gpSpent: 0,
  };
  if (typeof input.startedRound === 'number' && Number.isFinite(input.startedRound)) {
    project.startedRound = Math.floor(input.startedRound);
  }

  return {
    ok: true,
    data: { project },
    rolls: [],
    mutations: [
      {
        op: 'start_crafting',
        characterId: char.id,
        project,
      },
    ],
  };
}

/**
 * PHB §5 + DMG: advance an in-flight crafting project by `daysSpent`
 * days, optionally committing `gpDelta` more gp to materials.
 *
 * Errors:
 *   - `unknown_character`, `unknown_project`, `invalid_days`.
 */
export function handleProgressCrafting(
  state: EngineState,
  input: {
    character: string;
    projectId: string;
    daysSpent: number;
    gpDelta?: number;
  },
): ActionResult<{ projectId: string; daysSpent: number; gpDelta: number }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const projects = char.craftingProjects ?? [];
  const project = projects.find((p) => p.id === input.projectId);
  if (!project) {
    return { ok: false, error: 'unknown_project', rolls: [], mutations: [] };
  }
  if (
    typeof input.daysSpent !== 'number' ||
    !Number.isFinite(input.daysSpent) ||
    input.daysSpent < 0
  ) {
    return { ok: false, error: 'invalid_days', rolls: [], mutations: [] };
  }
  const gpDelta = Math.max(0, Math.floor(input.gpDelta ?? 0));
  const daysSpent = Math.floor(input.daysSpent);
  return {
    ok: true,
    data: { projectId: project.id, daysSpent, gpDelta },
    rolls: [],
    mutations: [
      {
        op: 'progress_crafting',
        characterId: char.id,
        projectId: project.id,
        daysSpent,
        gpDelta,
      },
    ],
  };
}

/**
 * PHB §5 + DMG: finalise a crafting project once the days remaining hit
 * zero. The applicator removes the project AND adds the recipe slug to
 * inventory; from the tool layer's perspective we just emit the
 * `complete_crafting` mutation.
 *
 * Errors:
 *   - `unknown_character`, `unknown_project`, `not_ready` (the project
 *     still has days remaining).
 */
export function handleCompleteCrafting(
  state: EngineState,
  input: { character: string; projectId: string },
): ActionResult<{ project: CraftingProject }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const projects = char.craftingProjects ?? [];
  const project = projects.find((p) => p.id === input.projectId);
  if (!project) {
    return { ok: false, error: 'unknown_project', rolls: [], mutations: [] };
  }
  if (project.daysRemaining > 0) {
    return { ok: false, error: 'not_ready', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { project },
    rolls: [],
    mutations: [
      {
        op: 'complete_crafting',
        characterId: char.id,
        projectId: project.id,
      },
    ],
  };
}

/**
 * PHB §5 + DMG: abandon a crafting project. No refund, no inventory
 * side-effect. Permissive: succeeds with `cancelled:false` if the id is
 * not present (master can call this without first verifying state).
 */
export function handleCancelCrafting(
  state: EngineState,
  input: { character: string; projectId: string },
): ActionResult<{ cancelled: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const projects = char.craftingProjects ?? [];
  const project = projects.find((p) => p.id === input.projectId);
  if (!project) {
    return {
      ok: true,
      data: { cancelled: false },
      rolls: [],
      mutations: [],
    };
  }
  return {
    ok: true,
    data: { cancelled: true },
    rolls: [],
    mutations: [
      {
        op: 'cancel_crafting',
        characterId: char.id,
        projectId: project.id,
      },
    ],
  };
}

// ─── Phase 13: downtime / hirelings / bastion (PHB §6 + 2024 PHB) ──────────

/** Generate a unique-enough id without depending on crypto APIs.
 *  Same fallback shape as `generateProjectId` for crafting. */
function generateId(prefix: string): string {
  const cryptoApi: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined'
      ? ((globalThis as { crypto?: { randomUUID?: () => string } }).crypto ?? undefined)
      : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const ts = Date.now().toString(36);
  const rnd = Math.floor(Math.random() * 1_000_000).toString(36);
  return `${prefix || 'id'}-${ts}-${rnd}`;
}

/**
 * PHB §6: kick off a downtime activity. Validates the kind and uses
 * `downtimeRequirements` for the default day count when none is
 * supplied. Generates a stable id so the master can address the
 * activity later via `complete_downtime_activity`.
 *
 * Errors:
 *   - `unknown_character` — character not found.
 *   - `invalid_activity` — kind not in the 5-value union.
 *   - `invalid_days` — days argument supplied but not a finite non-negative number.
 */
export function handleStartDowntimeActivity(
  state: EngineState,
  input: {
    character: string;
    activity: DowntimeActivityKind;
    days?: number;
    activityId?: string;
    startedAt?: number;
  },
): ActionResult<{ activity: DowntimeActivity }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!isValidDowntimeActivityKind(input.activity)) {
    return { ok: false, error: 'invalid_activity', rolls: [], mutations: [] };
  }
  let daysRemaining: number;
  if (typeof input.days === 'number') {
    if (!Number.isFinite(input.days) || input.days < 0) {
      return { ok: false, error: 'invalid_days', rolls: [], mutations: [] };
    }
    daysRemaining = Math.floor(input.days);
  } else {
    daysRemaining = downtimeRequirements(input.activity).daysRequired;
  }
  const activity: DowntimeActivity = {
    id:
      typeof input.activityId === 'string' && input.activityId.trim()
        ? input.activityId.trim()
        : generateId(`downtime-${input.activity}`),
    kind: input.activity,
    daysRemaining,
    gpSpent: 0,
  };
  if (typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)) {
    activity.startedAt = Math.floor(input.startedAt);
  }
  return {
    ok: true,
    data: { activity },
    rolls: [],
    mutations: [
      { op: 'start_downtime_activity', characterId: char.id, activity },
    ],
  };
}

/**
 * PHB §6: complete an in-flight downtime activity. The engine validates
 * the activity exists; the master narrates the outcome (success, fail,
 * partial) separately. The applicator removes the activity from
 * `downtimeActivities`.
 *
 * Errors:
 *   - `unknown_character`, `unknown_activity`.
 */
export function handleCompleteDowntimeActivity(
  state: EngineState,
  input: { character: string; activityId: string },
): ActionResult<{ activity: DowntimeActivity }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const activities = char.downtimeActivities ?? [];
  const activity = activities.find((a) => a.id === input.activityId);
  if (!activity) {
    return { ok: false, error: 'unknown_activity', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { activity },
    rolls: [],
    mutations: [
      { op: 'complete_downtime_activity', characterId: char.id, activityId: activity.id },
    ],
  };
}

/**
 * PHB §6: hire `count` hirelings of `kind` for `days`. Computes the
 * total cost via `hirelingTotalCost` (skilled = 2 gp/day, unskilled =
 * 2 sp/day). The engine does NOT enforce gp possession — the master
 * is responsible for the narrative deduction.
 *
 * Errors:
 *   - `unknown_character`, `invalid_kind`, `invalid_count`, `invalid_days`.
 */
export function handleHire(
  state: EngineState,
  input: {
    character: string;
    kind: 'skilled' | 'unskilled';
    count: number;
    days: number;
    hireId?: string;
    startedAt?: number;
  },
): ActionResult<{ hireling: Hireling }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (input.kind !== 'skilled' && input.kind !== 'unskilled') {
    return { ok: false, error: 'invalid_kind', rolls: [], mutations: [] };
  }
  if (
    typeof input.count !== 'number' ||
    !Number.isFinite(input.count) ||
    input.count <= 0
  ) {
    return { ok: false, error: 'invalid_count', rolls: [], mutations: [] };
  }
  if (
    typeof input.days !== 'number' ||
    !Number.isFinite(input.days) ||
    input.days <= 0
  ) {
    return { ok: false, error: 'invalid_days', rolls: [], mutations: [] };
  }
  const count = Math.floor(input.count);
  const days = Math.floor(input.days);
  const cost = hirelingTotalCost(input.kind, count, days);
  const hireling: Hireling = {
    id:
      typeof input.hireId === 'string' && input.hireId.trim()
        ? input.hireId.trim()
        : generateId(`hire-${input.kind}`),
    kind: input.kind,
    count,
    days,
    gpCost: cost.gp,
    spCost: cost.sp,
  };
  if (typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)) {
    hireling.startedAt = Math.floor(input.startedAt);
  }
  return {
    ok: true,
    data: { hireling },
    rolls: [],
    mutations: [{ op: 'hire', characterId: char.id, hireling }],
  };
}

/**
 * PHB §6: dismiss a hireling engagement by id. Validates the hireling
 * exists.
 *
 * Errors:
 *   - `unknown_character`, `unknown_hireling`.
 */
export function handleDismissHireling(
  state: EngineState,
  input: { character: string; hireId: string },
): ActionResult<{ hireling: Hireling }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const hirelings = char.hirelings ?? [];
  const hireling = hirelings.find((h) => h.id === input.hireId);
  if (!hireling) {
    return { ok: false, error: 'unknown_hireling', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { hireling },
    rolls: [],
    mutations: [
      { op: 'dismiss_hireling', characterId: char.id, hireId: hireling.id },
    ],
  };
}

/**
 * 2024 PHB simplified Bastion: establish (or replace) the PC's bastion.
 * Builds the default record via `buildDefaultBastion` so the room
 * count + defender garrison match the fortification tier.
 *
 * Errors:
 *   - `unknown_character`, `invalid_name`, `invalid_fortification`.
 */
export function handleSetBastion(
  state: EngineState,
  input: { character: string; name: string; fortification: BastionFortification },
): ActionResult<{ bastion: Bastion }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { ok: false, error: 'invalid_name', rolls: [], mutations: [] };
  }
  if (!isValidBastionFortification(input.fortification)) {
    return { ok: false, error: 'invalid_fortification', rolls: [], mutations: [] };
  }
  const bastion = buildDefaultBastion(name, input.fortification);
  return {
    ok: true,
    data: { bastion },
    rolls: [],
    mutations: [{ op: 'set_bastion', characterId: char.id, bastion }],
  };
}

/**
 * 2024 PHB simplified Bastion: append a room to `bastion.rooms`.
 * Requires the PC to already have a bastion (otherwise the master
 * must call `set_bastion` first).
 *
 * Errors:
 *   - `unknown_character`, `no_bastion`, `invalid_room_kind`,
 *     `invalid_room_level`.
 */
export function handleAddBastionRoom(
  state: EngineState,
  input: { character: string; kind: BastionRoomKind; level?: number },
): ActionResult<{ room: BastionRoom }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!char.bastion) {
    return { ok: false, error: 'no_bastion', rolls: [], mutations: [] };
  }
  if (!isValidBastionRoomKind(input.kind)) {
    return { ok: false, error: 'invalid_room_kind', rolls: [], mutations: [] };
  }
  const lvlRaw = input.level ?? 1;
  if (
    typeof lvlRaw !== 'number' ||
    !Number.isFinite(lvlRaw) ||
    ![1, 2, 3].includes(Math.floor(lvlRaw))
  ) {
    return { ok: false, error: 'invalid_room_level', rolls: [], mutations: [] };
  }
  const room: BastionRoom = {
    kind: input.kind,
    level: Math.floor(lvlRaw) as BastionRoom['level'],
  };
  return {
    ok: true,
    data: { room },
    rolls: [],
    mutations: [{ op: 'add_bastion_room', characterId: char.id, room }],
  };
}

// ─── Phase 14: mounted combat & vehicles (PHB §3.23, §9.6) ─────────────────

/**
 * PHB §3.23 — mount the rider on a creature serving as a mount. The mount
 * must exist as a `CombatActor` in the current scene (the master is the
 * source of truth for whether the mount is willing). When BOTH the rider
 * and the mount carry size data, the engine validates `canBeMount`
 * (mount must be at least one size larger). When either size is missing,
 * the engine permits the mount and lets the master narrate.
 *
 * `mode` defaults to `controlled` (the rider directs every turn) when
 * omitted; the master may pass `independent` for an intelligent steed
 * that acts on its own initiative.
 *
 * Errors:
 *   - `unknown_character` — the rider character is not in state.
 *   - `unknown_mount`     — no `CombatActor` matches the supplied id.
 *   - `invalid_mode`      — mode is not 'controlled' or 'independent'.
 *   - `mount_too_small`   — when both sizes are known, the mount must be
 *                           strictly larger than the rider.
 */
export function handleMount(
  state: EngineState,
  input: { rider: string; mount: string; mode?: MountMode },
): ActionResult<{ mounted: MountedState }> {
  const rider = state.characters.find((c) => c.id === input.rider);
  if (!rider) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  const mount = state.combatActors.find((a) => a.id === input.mount);
  if (!mount) {
    return { ok: false, error: 'unknown_mount', rolls: [], mutations: [] };
  }
  // Mode validation: when omitted, default to controlled. When supplied,
  // the value must be one of the legal `MountMode` literals.
  const modeInput = input.mode;
  if (modeInput !== undefined && !isValidMountMode(modeInput)) {
    return { ok: false, error: 'invalid_mode', rolls: [], mutations: [] };
  }
  const mode: MountMode = modeInput ?? 'controlled';
  // Size validation: only when BOTH rider and mount carry size data. The
  // engine stays permissive when either side is missing (the master may
  // narratively decide).
  // Riders are PCs; the engine derives a default 'medium' for them at the
  // type-system boundary by reading off the optional .size field; if the
  // master needs to override they can pre-stamp a different size.
  const riderSize = (rider as { size?: string }).size;
  const mountSize = mount.size;
  if (riderSize && mountSize) {
    // canBeMount expects Size types; both literals validated below.
    const ok = canBeMount(
      riderSize as Parameters<typeof canBeMount>[0],
      mountSize,
    );
    if (!ok) {
      return { ok: false, error: 'mount_too_small', rolls: [], mutations: [] };
    }
  }
  const mounted: MountedState = { mountId: mount.id, mode };
  return {
    ok: true,
    data: { mounted },
    rolls: [],
    mutations: [
      {
        op: 'mount',
        characterId: rider.id,
        mountId: mount.id,
        mode,
      },
    ],
  };
}

/**
 * PHB §3.23 — drop down off the current mount. Validates the rider is
 * currently mounted; the master is responsible for narrating the
 * dismount cost (half the rider's speed).
 *
 * Errors:
 *   - `unknown_character`, `not_mounted`.
 */
export function handleDismount(
  state: EngineState,
  input: { rider: string },
): ActionResult<{ mountId: string }> {
  const rider = state.characters.find((c) => c.id === input.rider);
  if (!rider) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!rider.mountedOn) {
    return { ok: false, error: 'not_mounted', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { mountId: rider.mountedOn.mountId },
    rolls: [],
    mutations: [{ op: 'dismount', characterId: rider.id }],
  };
}

/**
 * PHB §3.23 — switch the mount mode between `controlled` (rider directs;
 * mount may only Dash/Disengage/Dodge) and `independent` (mount uses its
 * own initiative). Requires the rider to currently be mounted.
 *
 * Errors:
 *   - `unknown_character`, `not_mounted`, `invalid_mode`.
 */
export function handleSetMountMode(
  state: EngineState,
  input: { rider: string; mode: MountMode },
): ActionResult<{ mounted: MountedState }> {
  const rider = state.characters.find((c) => c.id === input.rider);
  if (!rider) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!rider.mountedOn) {
    return { ok: false, error: 'not_mounted', rolls: [], mutations: [] };
  }
  if (!isValidMountMode(input.mode)) {
    return { ok: false, error: 'invalid_mode', rolls: [], mutations: [] };
  }
  const mounted: MountedState = {
    mountId: rider.mountedOn.mountId,
    mode: input.mode,
  };
  return {
    ok: true,
    data: { mounted },
    rolls: [],
    mutations: [
      {
        op: 'set_mount_mode',
        characterId: rider.id,
        mode: input.mode,
      },
    ],
  };
}

/**
 * PHB §9.6 — embark the PC on a vehicle from the engine's
 * `VEHICLE_CATALOG`. Validates the slug; the master narrates whether
 * the PC actually has access to the vehicle (e.g. owns it, is invited
 * aboard, snuck on as stowaway).
 *
 * Errors:
 *   - `unknown_character`, `unknown_vehicle`.
 */
export function handleEmbarkVehicle(
  state: EngineState,
  input: { character: string; vehicleSlug: string },
): ActionResult<{ vehicleSlug: string }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!isValidVehicleSlug(input.vehicleSlug)) {
    return { ok: false, error: 'unknown_vehicle', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { vehicleSlug: input.vehicleSlug },
    rolls: [],
    mutations: [
      {
        op: 'embark_vehicle',
        characterId: char.id,
        vehicleSlug: input.vehicleSlug,
      },
    ],
  };
}

/**
 * PHB §9.6 — disembark the PC from the current vehicle. Requires the
 * PC to currently be embarked.
 *
 * Errors:
 *   - `unknown_character`, `not_embarked`.
 */
export function handleDisembarkVehicle(
  state: EngineState,
  input: { character: string },
): ActionResult<{ vehicleSlug: string }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!char.embarkedOn) {
    return { ok: false, error: 'not_embarked', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { vehicleSlug: char.embarkedOn },
    rolls: [],
    mutations: [{ op: 'disembark_vehicle', characterId: char.id }],
  };
}

/**
 * PHB §3.23 — when an attack targets either the rider or their mount,
 * the rider may use their reaction to make the OTHER take the hit
 * instead. This tool is a NARRATIVE marker: it consumes the rider's
 * reaction (via `consume_action kind:'reaction'`) but does NOT redo
 * the attack — the master narrates the redirected hit and applies the
 * damage manually. The actual attack roll has already happened.
 *
 * Validation:
 *   - The rider must have their reaction available
 *     (`turnState.reactionUsed === false`).
 *   - One of `originalTargetId` / `newTargetId` must be the rider, and
 *     the other must be the rider's current mount. Otherwise the swap
 *     does not match the PHB §3.23 trigger and the engine refuses.
 *
 * Errors:
 *   - `unknown_character`, `not_mounted`, `reaction_already_used`,
 *     `invalid_swap_pair`.
 */
export function handleSwapAttackTarget(
  state: EngineState,
  input: { rider: string; originalTargetId: string; newTargetId: string },
): ActionResult<{ riderId: string; mountId: string }> {
  const rider = state.characters.find((c) => c.id === input.rider);
  if (!rider) {
    return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  }
  if (!rider.mountedOn) {
    return { ok: false, error: 'not_mounted', rolls: [], mutations: [] };
  }
  const runtime = state.runtime[rider.id];
  if (runtime?.turnState?.reactionUsed === true) {
    return {
      ok: false,
      error: 'reaction_already_used',
      rolls: [],
      mutations: [],
    };
  }
  const mountId = rider.mountedOn.mountId;
  // Exactly one of {original, new} must be the rider; the other must be
  // the mount. Reject any pairing that doesn't match the PHB §3.23
  // trigger.
  const pair = [input.originalTargetId, input.newTargetId];
  const matchesRiderMount =
    (pair[0] === rider.id && pair[1] === mountId) ||
    (pair[0] === mountId && pair[1] === rider.id);
  if (!matchesRiderMount) {
    return { ok: false, error: 'invalid_swap_pair', rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { riderId: rider.id, mountId },
    rolls: [],
    mutations: [
      { op: 'consume_action', actorId: rider.id, kind: 'reaction' },
    ],
  };
}

import { lookupCodex } from './lookup-codex';
import { lookupSpellMeta } from '@/srd/lookup';

export interface DbToolCtx {
  sessionId: string;
  state: EngineState;
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
    // PHB §8.3 — caster's hand state and material possession. Both default
    // to true (the master is the source of truth: pass false only when
    // a narrative reason exists).
    const freeHand = input.freeHand !== false;
    const hasMaterial = input.hasMaterial !== false;

    // Always fetch spellMeta from the SRD: castSpell now uses `castingTime` to
    // drive action-economy consumption (PHB §3.9 + §8.5), `components` for
    // PHB §8.3 V/S/M validation, in addition to the ritual flag check for
    // `asRitual` casts. Falls back to `undefined` if the spell isn't in the
    // SRD — castSpell will assume '1 action' and skip component validation.
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
      freeHand,
      hasMaterial,
    });
  },
};
