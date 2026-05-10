import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';
import { rollDice } from './dice';
import { defaultRng, createRng, type Rng } from './rand';
import { bindingFor } from './spells/spell-data';
import { ARCHETYPE_HANDLERS } from './spells/archetypes';
import { startConcentrationMutations } from './spells/concentration';
import { canConsumeAction } from './combat/turn-state';
import {
  parseComponents,
  validateComponents,
  focusKindForClass,
} from './spells/components';

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
  /**
   * Optional spell metadata. `castingTime` (e.g. '1 action', '1 bonus action',
   * '1 reaction', '1 minute') drives action-economy budget consumption and
   * PHB §8.5 enforcement when present. Defaults to a '1 action' assumption.
   * `components` is the PHB-style components string (e.g. "V S M (silver dust
   * worth 25 gp)"); when present, we validate V/S/M before consuming the
   * slot so refused casts don't burn resources.
   */
  spellMeta?: {
    ritual?: boolean;
    concentration?: boolean;
    castingTime?: string;
    components?: string;
  };
  /**
   * PHB §8.3-8.4 — caster has at least one free hand for the somatic
   * gesture. Defaults to true at the call site (the master is
   * responsible for setting false when both hands are visibly occupied
   * AND no focus is held).
   */
  freeHand?: boolean;
  /**
   * PHB §8.3 — caster has the spell's material in inventory (for spells
   * with explicit material costs). Defaults to true (the master decides
   * narratively; the engine assumes possession unless told otherwise).
   */
  hasMaterial?: boolean;
}

/**
 * Map a spell's casting-time string (as stored in the SRD) to the action-economy
 * kind it consumes. Returns `null` for casting times longer than a single combat
 * action (1 minute, 10 minutes, 1 hour, etc.) — those are out-of-combat-only and
 * should NOT consume an in-combat action slot.
 *
 * NB: ritual casts (10-minute extension) always supply their own non-action
 * casting time; the asRitual branch in castSpell takes precedence.
 */
function actionKindFromCastingTime(castingTime: string | undefined): 'action' | 'bonus' | 'reaction' | null {
  if (!castingTime) return 'action';  // default: assume 1-action spell
  const ct = castingTime.toLowerCase();
  if (ct.includes('bonus action')) return 'bonus';
  if (ct.includes('reaction')) return 'reaction';
  if (ct.includes('action')) return 'action';
  // longer cast times (1 minute, 10 minutes, 1 hour, …) → out-of-combat
  return null;
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

  // PHB §8.3 — V/S/M component validation. We run this BEFORE the action
  // economy and slot checks so a refused cast doesn't burn either. The
  // components string is optional; if absent (legacy callers, unknown
  // spells), we skip validation entirely. `freeHand` and `hasMaterial`
  // default to true — the master is the source of truth for hand state
  // and material possession.
  if (input.spellMeta?.components) {
    const components = parseComponents(input.spellMeta.components);
    const equippedFocus = input.caster.equippedFocus;
    const focusKind = focusKindForClass(input.caster.classSlug);
    const canUseFocus =
      !!equippedFocus && !!focusKind && focusKind === equippedFocus.kind;
    const componentError = validateComponents({
      components,
      casterConditions: input.runtime.conditions,
      freeHand: input.freeHand ?? true,
      equippedFocus,
      hasMaterial: input.hasMaterial ?? true,
      canUseFocus,
    });
    if (componentError) {
      return {
        ok: false,
        error: `component_${componentError}`,
        rolls: [],
        mutations: [],
      };
    }
  }

  // ACTION ECONOMY (PHB §3.9 + §8.5). Check BEFORE slot consumption so we don't
  // burn a slot on a refused cast. Skipped if:
  //   - the actor has no turnState (out-of-combat / backward compat), or
  //   - the casting time is longer than a single combat action (1 min, etc.),
  //   - the cast is a ritual (asRitual already implies a 10-min ritual cast).
  const ts = input.runtime.turnState;
  const actionKind = input.asRitual
    ? null
    : actionKindFromCastingTime(input.spellMeta?.castingTime);

  if (ts && actionKind) {
    // Budget guard: actor must still have the relevant slot free.
    if (!canConsumeAction(ts, actionKind)) {
      return {
        ok: false,
        error: `${actionKind}_already_used`,
        rolls: [],
        mutations: [],
      };
    }
    // PHB §8.5: if a bonus-action spell has been cast this turn, the only OTHER
    // spell allowed during the same turn is a cantrip with a 1-action casting
    // time. We enforce only the forward direction (bonus→other); the reverse
    // (action→bonus) would over-restrict because actionUsed is also set by
    // weapon attacks, dash, dodge, etc. — not just by spells.
    if (ts.bonusUsed && actionKind === 'action' && !isCantrip) {
      return {
        ok: false,
        error: 'bonus_action_spell_rule',
        rolls: [],
        mutations: [],
      };
    }
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

  // Action-consumption mutation. Emitted only when the actor tracks turnState
  // AND the casting time fits within a single combat turn. Ritual casts skip
  // this entirely (10-minute extension is out-of-combat by definition).
  const actionMutations: Mutation[] = (ts && actionKind)
    ? [{ op: 'consume_action', actorId: input.runtime.actorId, kind: actionKind }]
    : [];

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
      mutations: [...slotMutations, ...concMutations, ...actionMutations],
    };
  }

  // Magic missile keeps its bespoke handler: auto-hit, multi-dart per slot.
  if (input.spellSlug === 'magic-missile') {
    return castMagicMissile(input, engineRng, slotMutations, concMutations, actionMutations);
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
    mutations: [...handlerResult.mutations, ...slotMutations, ...concMutations, ...actionMutations],
  };
}

function castMagicMissile(
  input: CastSpellInput,
  rng: Rng,
  slotMutations: Mutation[],
  concMutations: Mutation[],
  actionMutations: Mutation[],
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
    mutations: [...mutations, ...slotMutations, ...concMutations, ...actionMutations],
  };
}
