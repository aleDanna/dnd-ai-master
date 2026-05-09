import type { Ability, ActionResult, ConditionSlug, DamageType, Mutation } from '../types';
import { rollDice } from '../dice';
import { createRng, type Rng } from '../rand';

export type Archetype =
  | 'attack_damage'
  | 'save_half'
  | 'save_negate'
  | 'save_condition'
  | 'heal'
  | 'buff'
  | 'aoe_save'
  | 'utility';

export interface ArchetypeBindingBase {
  archetype: Archetype;
  /** Damage scaling: base dice + extra dice per slot above min level */
  damage?: { dice: string; type: DamageType; perSlotAbove?: string };
  /** For attack-roll archetypes */
  attackRoll?: boolean;
  /** For save archetypes */
  save?: { ability: Ability; halfOnSuccess?: boolean };
  /** For condition-apply archetypes */
  condition?: { slug: ConditionSlug; durationRounds: number | 'until_removed' };
  /** For heal archetypes */
  heal?: { dice: string; perSlotAbove?: string; addSpellMod?: boolean };
  /** Number of targets (default 1) */
  targets?: { default: number; perSlotAbove?: number };
  /** For AoE — area shape descriptor (narrative, not currently enforced spatially) */
  aoe?: { shape: 'cone' | 'cube' | 'cylinder' | 'line' | 'sphere'; size: string };
  /** Min slot level (e.g. fireball = 3) */
  minSlot?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Whether casting this spell starts concentration */
  concentration?: boolean;
}

export type ArchetypeBinding = ArchetypeBindingBase;

export interface ArchetypeContext {
  caster: { id: string; spellAttackBonus: number; spellSaveDC: number; spellMod: number };
  spellSlug: string;
  slotLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  targets: { id: string; ac?: number }[];
  /** Uniform 0..1 RNG. Pure handlers; tests inject deterministic functions. */
  rng: () => number;
}

export type ArchetypeHandler = (
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
) => ActionResult<{ effects: string[] }>;

/**
 * Slot-level upcast helper. Given a `perSlotAbove` formula like `"1d6"` and
 * the current slot vs the spell's minimum slot, returns the extra dice to
 * roll. Returns null when there's no upcast (or scaling is missing).
 */
function extraDiceForUpcast(
  scaling: string | undefined,
  slot: number,
  minSlot: number,
): { count: number; sides: number } | null {
  if (!scaling || slot <= minSlot) return null;
  const m = scaling.match(/^(\d+)d(\d+)$/);
  if (!m) return null;
  return { count: parseInt(m[1]!, 10) * (slot - minSlot), sides: parseInt(m[2]!, 10) };
}

/** Wrap the uniform RNG into the engine's `Rng` interface for `rollDice`. */
function adaptRng(rng: () => number): Rng {
  return createRng(rng);
}

function handleAttackDamage(
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  if (!binding.damage) {
    return { ok: false, error: 'attack_damage requires damage', rolls: [], mutations: [] };
  }
  if (ctx.targets.length !== 1) {
    return { ok: false, error: 'attack_damage requires exactly 1 target', rolls: [], mutations: [] };
  }
  const target = ctx.targets[0]!;
  const diceRng = adaptRng(ctx.rng);

  const attackRoll = Math.floor(ctx.rng() * 20) + 1;
  const attackTotal = attackRoll + ctx.caster.spellAttackBonus;
  const isCrit = attackRoll === 20;
  const isMiss = attackRoll === 1;

  const hit = !isMiss && (isCrit || (target.ac != null && attackTotal >= target.ac));

  if (!hit) {
    return {
      ok: true,
      data: { effects: ['miss'] },
      rolls: [
        {
          formula: '1d20+attack',
          rolls: [attackRoll],
          modifier: ctx.caster.spellAttackBonus,
          total: attackTotal,
        },
      ],
      mutations: [],
    };
  }

  const dmgRoll = rollDice(binding.damage.dice, diceRng);
  const upcast = extraDiceForUpcast(binding.damage.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, diceRng) : null;
  const crit = isCrit ? rollDice(binding.damage.dice, diceRng) : null;
  const total = dmgRoll.total + (upcastRoll?.total ?? 0) + (crit?.total ?? 0);

  return {
    ok: true,
    data: { effects: ['attack-hit', binding.damage.type] },
    rolls: [
      {
        formula: '1d20+attack',
        rolls: [attackRoll],
        modifier: ctx.caster.spellAttackBonus,
        total: attackTotal,
      },
      dmgRoll,
      ...(upcastRoll ? [upcastRoll] : []),
      ...(crit ? [crit] : []),
    ],
    mutations: [
      { op: 'apply_damage', actorId: target.id, amount: total, type: binding.damage.type, isCrit } as Mutation,
    ],
  };
}

function handleSaveDamage(
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  if (!binding.damage || !binding.save) {
    return { ok: false, error: 'save_damage requires damage + save', rolls: [], mutations: [] };
  }
  // The AI Master will resolve target save via saving_throw tool with DC = ctx.caster.spellSaveDC.
  // This handler emits an apply_damage mutation per target assuming FAIL (full damage).
  // The Master is expected to halve the value on success when binding.save.halfOnSuccess.
  const diceRng = adaptRng(ctx.rng);
  const dmgRoll = rollDice(binding.damage.dice, diceRng);
  const upcast = extraDiceForUpcast(binding.damage.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, diceRng) : null;
  const total = dmgRoll.total + (upcastRoll?.total ?? 0);

  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'apply_damage' as const,
    actorId: t.id,
    amount: total,
    type: binding.damage!.type,
  }));

  return {
    ok: true,
    data: {
      effects: [
        binding.save.halfOnSuccess ? 'save_half' : 'save_negate',
        binding.damage.type,
      ],
    },
    rolls: [dmgRoll, ...(upcastRoll ? [upcastRoll] : [])],
    mutations: muts,
  };
}

function handleSaveCondition(
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  if (!binding.save || !binding.condition) {
    return { ok: false, error: 'save_condition requires save + condition', rolls: [], mutations: [] };
  }
  // Emits add_condition for each target, assuming the save FAILED.
  // The AI Master decides per-target via saving_throw and removes the condition for successes.
  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'add_condition' as const,
    actorId: t.id,
    condition: {
      slug: binding.condition!.slug,
      source: ctx.spellSlug,
      durationRounds: binding.condition!.durationRounds,
      appliedRound: 0,
    },
  }));
  return {
    ok: true,
    data: { effects: [`condition:${binding.condition.slug}`] },
    rolls: [],
    mutations: muts,
  };
}

function handleHeal(
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  if (!binding.heal) {
    return { ok: false, error: 'heal requires heal binding', rolls: [], mutations: [] };
  }
  if (ctx.targets.length === 0) {
    return { ok: false, error: 'heal requires at least 1 target', rolls: [], mutations: [] };
  }
  const diceRng = adaptRng(ctx.rng);
  const dmgRoll = rollDice(binding.heal.dice, diceRng);
  const upcast = extraDiceForUpcast(binding.heal.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, diceRng) : null;
  const mod = binding.heal.addSpellMod ? ctx.caster.spellMod : 0;
  const totalHeal = dmgRoll.total + (upcastRoll?.total ?? 0) + mod;

  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'heal' as const,
    actorId: t.id,
    amount: totalHeal,
  }));
  return {
    ok: true,
    data: { effects: ['heal'] },
    rolls: [dmgRoll, ...(upcastRoll ? [upcastRoll] : [])],
    mutations: muts,
  };
}

function handleBuff(
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  if (!binding.condition) {
    return { ok: false, error: 'buff requires condition slug', rolls: [], mutations: [] };
  }
  // Buffs are encoded as conditions (e.g. 'blessed', 'baned'). The Master applies
  // narrative effects from the slug; this gives a uniform contract.
  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'add_condition' as const,
    actorId: t.id,
    condition: {
      slug: binding.condition!.slug,
      source: ctx.spellSlug,
      durationRounds: binding.condition!.durationRounds,
      appliedRound: 0,
    },
  }));
  return {
    ok: true,
    data: { effects: [`buff:${binding.condition.slug}`] },
    rolls: [],
    mutations: muts,
  };
}

function handleAoeSave(
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  // Mechanically identical to save_half/save_negate; the difference is conceptual
  // (multiple targets in a shape). The AI Master enumerates targets in the area.
  return handleSaveDamage(ctx, binding);
}

function handleUtility(
  _ctx: ArchetypeContext,
  _binding: ArchetypeBinding,
): ActionResult<{ effects: string[] }> {
  // Utility spells (light, mage hand, prestidigitation): no mechanical resolution
  // beyond slot consumption (handled upstream by castSpell). The Master narrates.
  return { ok: true, data: { effects: ['utility'] }, rolls: [], mutations: [] };
}

export const ARCHETYPE_HANDLERS: Record<Archetype, ArchetypeHandler> = {
  attack_damage: handleAttackDamage,
  save_half: handleSaveDamage,
  save_negate: handleSaveDamage,
  save_condition: handleSaveCondition,
  heal: handleHeal,
  buff: handleBuff,
  aoe_save: handleAoeSave,
  utility: handleUtility,
};
