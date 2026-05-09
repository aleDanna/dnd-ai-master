import type { ActionResult, DiceRoll, EngineState, Mutation } from '../types';
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

function resolveCharacterId(state: EngineState, actorRef: unknown): string {
  if (typeof actorRef === 'string' && actorRef === 'player_character' && state.characters.length === 1) {
    return state.characters[0]!.id;
  }
  return String(actorRef);
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
