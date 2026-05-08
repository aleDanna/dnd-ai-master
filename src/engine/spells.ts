import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';
import { rollDice } from './dice';
import { defaultRng, type Rng } from './rand';

type LeveledSlot = 1|2|3|4|5|6|7|8|9;
type SlotLevel = 0 | LeveledSlot;

export interface CastSpellInput {
  caster: Character;
  runtime: ActorRuntimeState;
  spellSlug: string;
  /** 0 for cantrips (no slot consumed). 1-9 for leveled casts. */
  slotLevel: SlotLevel;
  targets: { id: string }[];
}

export function castSpell(input: CastSpellInput, rng: Rng = defaultRng): ActionResult<{ effects: string[] }> {
  if (!input.caster.spellcasting) {
    return { ok: false, error: 'not_caster', rolls: [], mutations: [] };
  }
  if (!input.caster.spellcasting.spellsKnown.includes(input.spellSlug)) {
    return { ok: false, error: 'not_known', rolls: [], mutations: [] };
  }

  const isCantrip = input.slotLevel === 0;
  if (!isCantrip) {
    const lvl = input.slotLevel as LeveledSlot;
    const max = input.caster.spellcasting.slotsMax[lvl] ?? 0;
    const used = input.runtime.spellSlotsUsed?.[lvl] ?? 0;
    if (max - used <= 0) {
      return { ok: false, error: 'no_slot', rolls: [], mutations: [] };
    }
  }

  const slotMutations: Mutation[] = isCantrip
    ? []
    : [{ op: 'use_spell_slot', actorId: input.runtime.actorId, level: input.slotLevel as LeveledSlot }];

  const handler = SPELL_HANDLERS[input.spellSlug];
  // No specialised mechanical handler: succeed as a "narrative cast". The master
  // is responsible for any follow-up rolls / damage / conditions via separate
  // tool calls (apply_damage, saving_throw, apply_condition, etc.). Returning
  // ok here avoids the master having to fake-resolve the cast when an SRD spell
  // simply doesn't have a hard-coded handler.
  if (!handler) {
    return { ok: true, data: { effects: [] }, rolls: [], mutations: slotMutations };
  }

  const result = handler(input, rng);
  if (!result.ok) return result;

  return { ...result, mutations: [...result.mutations, ...slotMutations] };
}

type SpellHandler = (input: CastSpellInput, rng: Rng) => ActionResult<{ effects: string[] }>;

const SPELL_HANDLERS: Record<string, SpellHandler> = {
  'magic-missile': (input, rng) => {
    const dartCount = 2 + input.slotLevel;
    if (input.targets.length < 1 || input.targets.length > dartCount) {
      return { ok: false, error: 'bad_targets', rolls: [], mutations: [] };
    }
    const rolls = [];
    const mutations: Mutation[] = [];
    for (let i = 0; i < dartCount; i++) {
      const r = rollDice('1d4+1', rng);
      rolls.push(r);
      const tgt = input.targets[i] ?? input.targets[input.targets.length - 1]!;
      mutations.push({ op: 'apply_damage', actorId: tgt.id, amount: r.total, type: 'force' });
    }
    return { ok: true, data: { effects: ['force-damage'] }, rolls, mutations };
  },

  'healing-word': (input, rng) => {
    if (input.targets.length !== 1) {
      return { ok: false, error: 'bad_targets', rolls: [], mutations: [] };
    }
    const target = input.targets[0]!;
    const dice = `1d4`;
    const r = rollDice(dice, rng);
    // +spellcasting modifier
    const ability = input.caster.spellcasting!.ability;
    const mod = Math.floor((input.caster.abilities[ability] - 10) / 2);
    const upcast = (input.slotLevel - 1) > 0 ? Array.from({ length: input.slotLevel - 1 }, () => rollDice('1d4', rng)) : [];
    const total = r.total + mod + upcast.reduce((s, x) => s + x.total, 0);
    return {
      ok: true,
      data: { effects: ['heal'] },
      rolls: [r, ...upcast],
      mutations: [{ op: 'heal', actorId: target.id, amount: total }],
    };
  },

};

