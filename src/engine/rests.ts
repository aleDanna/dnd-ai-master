import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';
import { rollDice } from './dice';
import { abilityModifier } from './modifiers';
import { defaultRng, type Rng } from './rand';

// Features that recharge on a short rest. Conservative list; more are added in Plan D.
const SHORT_REST_RECHARGES = new Set([
  'second_wind',
  'action_surge',     // actually long-rest in 5e RAW; check level (Fighter regains at SR from level 17). Default: long-rest.
  'channel_divinity',
  'ki',
  'arcane_recovery',
  'song_of_rest',
  'bardic_inspiration',
]);
// Override: action_surge is technically long-rest at lower levels. Keep simple in Plan B:
const ACTUALLY_LONG_REST = new Set(['action_surge']);

export interface ShortRestInput {
  char: Character;
  runtime: ActorRuntimeState;
  hitDiceSpent: number;
}

export function shortRest(input: ShortRestInput, rng: Rng = defaultRng): ActionResult<{ healed: number }> {
  const remaining = input.runtime.hitDiceRemaining ?? 0;
  if (input.hitDiceSpent > remaining) {
    return { ok: false, error: 'not_enough_hit_dice', rolls: [], mutations: [] };
  }
  const conMod = abilityModifier(input.char.abilities.CON);
  const rolls = [];
  let totalHeal = 0;
  for (let i = 0; i < input.hitDiceSpent; i++) {
    const r = rollDice(`1d${input.char.hitDieSize}`, rng);
    rolls.push(r);
    totalHeal += r.total + conMod;
  }
  const mutations: Mutation[] = [];
  for (let i = 0; i < input.hitDiceSpent; i++) {
    mutations.push({ op: 'spend_hit_die', actorId: input.runtime.actorId });
  }
  if (totalHeal > 0) {
    mutations.push({ op: 'heal', actorId: input.runtime.actorId, amount: totalHeal });
  }

  // Recharge short-rest resources
  for (const f of input.char.features) {
    if (!SHORT_REST_RECHARGES.has(f.slug)) continue;
    if (ACTUALLY_LONG_REST.has(f.slug)) continue;
    const used = input.runtime.resourcesUsed?.[f.slug] ?? 0;
    if (used > 0) {
      mutations.push({ op: 'restore_resource', actorId: input.runtime.actorId, featureSlug: f.slug, amount: used });
    }
  }

  return { ok: true, data: { healed: totalHeal }, rolls, mutations };
}

export interface LongRestInput {
  char: Character;
  runtime: ActorRuntimeState;
  /**
   * PHB §5.2: ms since epoch of the most recent successful long rest. When
   * undefined, the PC has never long-rested (no cooldown to enforce). When
   * present and within 24h of `currentEpochMs`, the rest is rejected.
   */
  lastLongRestAtMs?: number;
  /**
   * Current ms since epoch — used to (a) compare against `lastLongRestAtMs`
   * for the cooldown, and (b) stamp the new `set_long_rest_at` mutation.
   * Defaults to `Date.now()` when omitted.
   */
  currentEpochMs?: number;
  /**
   * PHB §5.2: minutes of strenuous activity (combat, casting, walking ≥1h)
   * during the rest. ≥60 invalidates the rest entirely — caller must restart.
   */
  interruptedByMinutes?: number;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function longRest(input: LongRestInput): ActionResult<{ restored: string[] }> {
  // PHB §5.2 (Long Rest, requirements):
  // 1) Cannot long-rest at 0 HP — must be stabilized or healed first.
  if (input.runtime.hpCurrent < 1) {
    return { ok: false, error: 'cannot_rest_at_zero_hp', rolls: [], mutations: [] };
  }
  // 2) "A character can't benefit from more than one long rest in a 24-hour
  //    period." Compare against the persisted timestamp.
  const now = input.currentEpochMs ?? Date.now();
  if (
    input.lastLongRestAtMs != null &&
    now - input.lastLongRestAtMs < TWENTY_FOUR_HOURS_MS
  ) {
    return { ok: false, error: 'long_rest_cooldown', rolls: [], mutations: [] };
  }
  // 3) "If the rest is interrupted by a period of strenuous activity […] of
  //    at least 1 hour, the characters must begin the rest again to gain
  //    any benefit from it."
  if ((input.interruptedByMinutes ?? 0) >= 60) {
    return { ok: false, error: 'long_rest_interrupted', rolls: [], mutations: [] };
  }

  const mutations: Mutation[] = [
    { op: 'set_hp', actorId: input.runtime.actorId, hpCurrent: input.char.hpMax },
    { op: 'set_temp_hp', actorId: input.runtime.actorId, amount: 0 },
  ];

  // Restore all spell slots — one mutation per level that has consumed slots.
  // The applicator decrements `spellSlotsUsed[level]` by `amount`, clamped at 0.
  if (input.runtime.spellSlotsUsed) {
    for (const [lvlStr, usedCount] of Object.entries(input.runtime.spellSlotsUsed)) {
      const lvl = Number(lvlStr) as 1|2|3|4|5|6|7|8|9;
      if (typeof usedCount === 'number' && usedCount > 0) {
        mutations.push({ op: 'restore_spell_slot', actorId: input.runtime.actorId, level: lvl, amount: usedCount });
      }
    }
  }

  // Restore up to half max hit dice (rounded down, minimum 1)
  const used = input.char.hitDiceMax - (input.runtime.hitDiceRemaining ?? input.char.hitDiceMax);
  const recovered = Math.min(used, Math.max(1, Math.floor(input.char.hitDiceMax / 2)));
  if (recovered > 0) {
    mutations.push({ op: 'restore_hit_dice', actorId: input.runtime.actorId, amount: recovered });
  }

  // Restore all class resources
  const restored: string[] = [];
  for (const f of input.char.features) {
    const usedR = input.runtime.resourcesUsed?.[f.slug] ?? 0;
    if (usedR > 0) {
      mutations.push({ op: 'restore_resource', actorId: input.runtime.actorId, featureSlug: f.slug, amount: usedR });
      restored.push(f.slug);
    }
  }

  // PHB §4.1: a long rest reduces the character's exhaustion level by 1.
  // The applicator's exhaustion-stacking handler treats `remove_condition`
  // exhaustion as a decrement (and drops the slug at level 0).
  if ((input.runtime.exhaustionLevel ?? 0) > 0) {
    mutations.push({
      op: 'remove_condition',
      actorId: input.runtime.actorId,
      conditionSlug: 'exhaustion',
    });
  }

  // Stamp the new long-rest timestamp on session_state so the next call can
  // enforce the §5.2 24h cooldown.
  mutations.push({ op: 'set_long_rest_at', epochMs: now });

  return { ok: true, data: { restored }, rolls: [], mutations };
}
