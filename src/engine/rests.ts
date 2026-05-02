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
}

export function longRest(input: LongRestInput): ActionResult<{ restored: string[] }> {
  const mutations: Mutation[] = [
    { op: 'set_hp', actorId: input.runtime.actorId, hpCurrent: input.char.hpMax },
    { op: 'set_temp_hp', actorId: input.runtime.actorId, amount: 0 },
  ];

  // Restore all spell slots
  if (input.runtime.spellSlotsUsed) {
    // We can't iterate without level-keys; let Plan D's applicator zero them out.
    // For our mutation list we emit one synthetic op via use_spell_slot? No — easier: loop.
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

  return { ok: true, data: { restored }, rolls: [], mutations };
}
