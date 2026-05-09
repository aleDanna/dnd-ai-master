import type { ActionResult, DiceRoll, EngineState, Mutation } from '../types';
import { rollDice as rollDiceFn, rollD20 as rollD20Fn } from '../dice';
import { abilityCheck, savingThrow } from '../checks';
import { rollInitiative } from '../combat/initiative';
import { makeAttack } from '../combat/attack';
import { applyDamage } from '../combat/damage';
import { endTurn } from '../combat/turn';
import { castSpell } from '../spells';
import { applyCondition, removeCondition } from '../conditions';
import { useResource as consumeResource } from '../resources';
import { shortRest, longRest } from '../rests';
import { equip, unequip, recomputeAC } from '../equipment';
import { levelUp } from '../levelup';

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

  long_rest: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return longRest({ char, runtime });
  },

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

    // Fetch spellMeta from the SRD only when actually needed (asRitual cast).
    // For normal casts, spellMeta isn't required by castSpell — the engine's
    // own bindings carry the concentration flag. This keeps the common path
    // free of an extra DB round-trip.
    const spellMeta = asRitual ? await lookupSpellMeta(spellSlug) : undefined;

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
