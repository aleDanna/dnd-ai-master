import type { ActionResult, EngineState } from '../types';
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
    return abilityCheck({
      char,
      skill: input.skill as never,
      ability: input.ability as never,
      dc: Number(input.dc),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
  },

  saving_throw: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return savingThrow({
      char,
      ability: input.ability as never,
      dc: Number(input.dc),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
  },

  roll_initiative: (state) => {
    return rollInitiative({ pcs: state.characters, monsters: state.combatActors });
  },

  make_attack: (state, input) => {
    const attackerId = resolveCharacterId(state, input.attacker);
    const attacker = state.characters.find((c) => c.id === attackerId);
    if (!attacker) return { ok: false, error: 'unknown_attacker', rolls: [], mutations: [] };
    const target = state.combatActors.find((a) => a.id === String(input.target));
    if (!target) return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
    const weaponInput = input.weapon as Record<string, unknown>;
    if (!weaponInput || typeof weaponInput !== 'object') return { ok: false, error: 'bad_weapon', rolls: [], mutations: [] };
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

  cast_spell: (state, input) => {
    const casterId = resolveCharacterId(state, input.caster);
    const caster = state.characters.find((c) => c.id === casterId);
    const runtime = state.runtime[casterId];
    if (!caster || !runtime) return { ok: false, error: 'unknown_caster', rolls: [], mutations: [] };
    return castSpell({
      caster,
      runtime,
      spellSlug: String(input.spellSlug),
      slotLevel: Number(input.slotLevel) as 0|1|2|3|4|5|6|7|8|9,
      targets: ((input.targets as { id: string }[]) ?? []).map((t) => ({ id: String(t.id) })),
    });
  },

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
};

function resolveCharacterId(state: EngineState, actorRef: unknown): string {
  if (typeof actorRef === 'string' && actorRef === 'player_character' && state.characters.length === 1) {
    return state.characters[0]!.id;
  }
  return String(actorRef);
}

import { lookupCodex } from './lookup-codex';

export interface DbToolCtx {
  sessionId: string;
}

export type DbToolHandler = (
  ctx: DbToolCtx,
  input: Record<string, unknown>,
) => Promise<import('../types').ActionResult>;

export const TOOL_HANDLERS_DB: Record<string, DbToolHandler> = {
  lookup_codex: (ctx, input) => lookupCodex(ctx, input),
};
