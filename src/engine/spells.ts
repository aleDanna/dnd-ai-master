import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';
import { rollDice } from './dice';
import { defaultRng, createRng, type Rng } from './rand';
import { bindingFor } from './spells/spell-data';
import { ARCHETYPE_HANDLERS } from './spells/archetypes';
import { startConcentrationMutations } from './spells/concentration';

type LeveledSlot = 1|2|3|4|5|6|7|8|9;
type SlotLevel = 0 | LeveledSlot;

export interface CastSpellInput {
  caster: Character;
  runtime: ActorRuntimeState;
  spellSlug: string;
  /** 0 for cantrips (no slot consumed). 1-9 for leveled casts. */
  slotLevel: SlotLevel;
  targets: { id: string; ac?: number }[];
  /** Current combat round (for concentration tracking). Defaults to 0. */
  currentRound?: number;
  /** If true, cast as a ritual: spell must support ritual; no slot consumed. */
  asRitual?: boolean;
  /** Optional spell metadata (ritual/concentration) — required when asRitual=true. */
  spellMeta?: { ritual?: boolean; concentration?: boolean };
}

/**
 * Accept either the engine's `Rng` (object with `intInclusive`) for backwards
 * compatibility with seeded test helpers, OR a uniform `() => number` so tests
 * can pass `() => 0.5` directly. Internally we normalise to both forms — the
 * archetype handlers consume `() => number`, the legacy magic-missile path
 * consumes `Rng`.
 */
type RngArg = Rng | (() => number);

function normaliseRng(rng: RngArg): { engine: Rng; uniform: () => number } {
  if (typeof rng === 'function') {
    return { engine: createRng(rng), uniform: rng };
  }
  // Synthesise a uniform 0..1 from an `Rng` so we can drive archetype handlers
  // deterministically when callers pass a seeded `Rng`.
  const uniform = () => rng.intInclusive(0, 0xFFFFFFFF) / 0x100000000;
  return { engine: rng, uniform };
}

export function castSpell(input: CastSpellInput, rng: RngArg = defaultRng): ActionResult<{ effects: string[] }> {
  if (!input.caster.spellcasting) {
    return { ok: false, error: 'not_caster', rolls: [], mutations: [] };
  }
  if (!input.caster.spellcasting.spellsKnown.includes(input.spellSlug)) {
    return { ok: false, error: 'not_known', rolls: [], mutations: [] };
  }

  const isCantrip = input.slotLevel === 0;

  // RITUAL CHECK: if asRitual, the spell must support ritual casting.
  if (input.asRitual) {
    if (!input.spellMeta?.ritual) {
      return { ok: false, error: 'spell is not a ritual', rolls: [], mutations: [] };
    }
  }

  const binding = bindingFor(input.spellSlug);

  // MIN-SLOT GUARD: reject casts that supply a slot level below the binding's
  // minimum. Without this guard a caller could pass slotLevel=0 for a leveled
  // spell (cure-wounds, fireball, hold-person…) and the engine would skip the
  // slot consumption while still emitting the full effect mutations. Unbound
  // spells (no binding) keep the legacy "narrative cast" path — minSlot
  // defaults to 0, so any slot level is accepted.
  const minSlot = binding?.minSlot ?? 0;
  if (input.slotLevel < minSlot) {
    return { ok: false, error: 'slot_too_low', rolls: [], mutations: [] };
  }

  // SLOT CHECK (skipped for cantrip OR ritual cast).
  if (!isCantrip && !input.asRitual) {
    const lvl = input.slotLevel as LeveledSlot;
    const max = input.caster.spellcasting.slotsMax[lvl] ?? 0;
    const used = input.runtime.spellSlotsUsed?.[lvl] ?? 0;
    if (max - used <= 0) {
      return { ok: false, error: 'no_slot', rolls: [], mutations: [] };
    }
  }

  const slotMutations: Mutation[] = (isCantrip || input.asRitual)
    ? []
    : [{ op: 'use_spell_slot', actorId: input.runtime.actorId, level: input.slotLevel as LeveledSlot }];

  // CONCENTRATION mutations (only if the spell binding flags it).
  const concMutations: Mutation[] = binding?.concentration
    ? startConcentrationMutations({
        actorId: input.runtime.actorId,
        spellSlug: input.spellSlug,
        slotLevel: input.slotLevel,
        startedRound: input.currentRound ?? 0,
        currentlyConcentratingOn: input.runtime.concentratingOn,
      })
    : [];

  const { engine: engineRng, uniform } = normaliseRng(rng);

  // No binding → narrative cast (legacy behaviour). Slot is still consumed (or
  // skipped for ritual). The Master narrates / drives downstream tools.
  if (!binding) {
    const effects = input.asRitual ? ['ritual', 'narrative'] : ['narrative'];
    return {
      ok: true,
      data: { effects },
      rolls: [],
      mutations: [...slotMutations, ...concMutations],
    };
  }

  // Magic missile keeps its bespoke handler: auto-hit, multi-dart per slot.
  if (input.spellSlug === 'magic-missile') {
    return castMagicMissile(input, engineRng, slotMutations, concMutations);
  }

  const handler = ARCHETYPE_HANDLERS[binding.archetype];
  const ability = input.caster.spellcasting.ability;
  const ctx = {
    caster: {
      id: input.runtime.actorId,
      spellAttackBonus: input.caster.spellcasting.spellAttackBonus,
      spellSaveDC: input.caster.spellcasting.spellSaveDC,
      spellMod: Math.floor((input.caster.abilities[ability] - 10) / 2),
    },
    spellSlug: input.spellSlug,
    slotLevel: input.slotLevel,
    targets: input.targets,
    rng: uniform,
    currentRound: input.currentRound ?? 0,
    casterLevel: input.caster.level,
  };
  const handlerResult = handler(ctx, binding);
  if (!handlerResult.ok) return handlerResult;

  const allEffects = [
    ...(handlerResult.data?.effects ?? []),
    ...(input.asRitual ? ['ritual'] : []),
  ];

  return {
    ok: true,
    data: { effects: allEffects },
    rolls: handlerResult.rolls,
    mutations: [...handlerResult.mutations, ...slotMutations, ...concMutations],
  };
}

function castMagicMissile(
  input: CastSpellInput,
  rng: Rng,
  slotMutations: Mutation[],
  concMutations: Mutation[],
): ActionResult<{ effects: string[] }> {
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
  return {
    ok: true,
    data: { effects: ['force-damage'] },
    rolls,
    mutations: [...mutations, ...slotMutations, ...concMutations],
  };
}
