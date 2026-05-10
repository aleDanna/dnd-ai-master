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
  /**
   * Current combat round, used to stamp `appliedRound` on conditions / buffs
   * emitted by handlers. Defaults to 0 if not supplied (out-of-combat casts).
   */
  currentRound?: number;
  /**
   * Caster character level (1..20). Used for PHB §10 cantrip damage scaling
   * (multiplier increases at character level 5/11/17). Optional so legacy
   * callers without scaling expectations still work.
   */
  casterLevel?: number;
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

/**
 * PHB §10 cantrip damage scaling. Cantrips multiply their base dice count
 * at character level 5/11/17:
 *   - Level 1-4 → ×1
 *   - Level 5-10 → ×2
 *   - Level 11-16 → ×3
 *   - Level 17-20 → ×4
 * Modifiers (e.g. "1d10+1") are preserved verbatim. Returns the original
 * formula when not a cantrip or when caster level is unknown.
 */
function applyCantripScaling(
  diceFormula: string,
  isCantrip: boolean,
  casterLevel: number | undefined,
): string {
  if (!isCantrip || !casterLevel) return diceFormula;
  const m = diceFormula.match(/^(\d+)d(\d+)(.*)$/);
  if (!m) return diceFormula;
  const count = parseInt(m[1]!, 10);
  const sides = parseInt(m[2]!, 10);
  const rest = m[3] ?? '';
  const multiplier =
    casterLevel >= 17 ? 4
    : casterLevel >= 11 ? 3
    : casterLevel >= 5 ? 2
    : 1;
  return `${count * multiplier}d${sides}${rest}`;
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
  if (target.ac == null) {
    return {
      ok: false,
      error: `attack_damage requires target.ac (target ${target.id} missing)`,
      rolls: [],
      mutations: [],
    };
  }
  const diceRng = adaptRng(ctx.rng);

  const attackRoll = Math.floor(ctx.rng() * 20) + 1;
  const attackTotal = attackRoll + ctx.caster.spellAttackBonus;
  const isCrit = attackRoll === 20;
  const isMiss = attackRoll === 1;

  const hit = !isMiss && (isCrit || attackTotal >= target.ac);

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

  const isCantrip = (binding.minSlot ?? 0) === 0;
  const scaledDice = applyCantripScaling(binding.damage.dice, isCantrip, ctx.casterLevel);
  const dmgRoll = rollDice(scaledDice, diceRng);
  const upcast = extraDiceForUpcast(binding.damage.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, diceRng) : null;
  // PHB §3.11: a critical hit doubles ALL damage dice, including bonus dice.
  // Upcast dice (perSlotAbove) are bonus damage and should also re-roll on crit.
  const crit = isCrit ? rollDice(scaledDice, diceRng) : null;
  const upcastCrit = isCrit && upcast ? rollDice(`${upcast.count}d${upcast.sides}`, diceRng) : null;
  const total =
    dmgRoll.total +
    (upcastRoll?.total ?? 0) +
    (crit?.total ?? 0) +
    (upcastCrit?.total ?? 0);

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
      ...(upcastCrit ? [upcastCrit] : []),
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
  const isCantrip = (binding.minSlot ?? 0) === 0;
  const scaledDice = applyCantripScaling(binding.damage.dice, isCantrip, ctx.casterLevel);
  const dmgRoll = rollDice(scaledDice, diceRng);
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
      appliedRound: ctx.currentRound ?? 0,
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
      appliedRound: ctx.currentRound ?? 0,
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
