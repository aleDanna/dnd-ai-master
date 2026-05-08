import type { ActionResult, ActorRuntimeState, Character, CombatActor, ConditionInstance, DamageType, Mutation } from '../types';
import { attackBonus, abilityModifier } from '../modifiers';
import { rollD20, rollDamage } from '../dice';
import { defaultRng, type Rng } from '../rand';
import { getEffectsForActor } from '../condition-effects';

export interface WeaponSpec {
  name: string;
  damage: string;          // e.g. "1d8"
  damageType: DamageType;
  profGroup: string;       // proficiency group
  useDex: boolean;         // use DEX instead of STR for to-hit and damage
}

export interface MakeAttackInput {
  attacker: Character;
  target: CombatActor;
  weapon: WeaponSpec;
  advantage?: boolean;
  disadvantage?: boolean;
  /** Runtime state of the attacker — used to resolve current conditions/exhaustion. Optional for backward compat. */
  attackerRuntime?: ActorRuntimeState;
  /** Runtime state of the target — used to resolve current conditions/exhaustion. Optional for backward compat. */
  targetRuntime?: ActorRuntimeState;
  /** When true, the attack is a ranged weapon attack. Defaults to false (melee). */
  ranged?: boolean;
  /** Distance (ft) of the melee attack. Defaults to 5. Only consulted for melee. */
  meleeRange?: number;
  /**
   * If true and the attack is melee and a hit reduces the target to ≤0 HP,
   * the attacker chooses to knock the target unconscious instead of killing.
   * Emits `set_hp 0` + `add_condition unconscious` instead of normal damage.
   * Ranged attacks silently ignore this flag (PHB §3.20).
   */
  knockOut?: boolean;
}

export interface MakeAttackResultData {
  hit: boolean;
  crit: boolean;
  rawDamage: number;
  finalDamage: number;
  knockedOut?: boolean;
}

function effectsFromRuntime(runtime: ActorRuntimeState | undefined): ReturnType<typeof getEffectsForActor> {
  const conditions: ConditionInstance[] = runtime?.conditions ?? [];
  return getEffectsForActor(conditions, { exhaustionLevel: runtime?.exhaustionLevel });
}

export function makeAttack(input: MakeAttackInput, rng: Rng = defaultRng): ActionResult<MakeAttackResultData> {
  const fxAttacker = effectsFromRuntime(input.attackerRuntime);
  const fxTarget = effectsFromRuntime(input.targetRuntime);

  // Incapacitated attackers cannot take actions (PHB Appendix A — incapacitated).
  if (fxAttacker.incapacitated) {
    return {
      ok: false,
      error: 'attacker incapacitated',
      rolls: [],
      mutations: [],
    };
  }

  const isMelee = !input.ranged;
  const meleeWithin5 = isMelee && (input.meleeRange ?? 5) <= 5;

  // OR all sources of advantage / disadvantage.
  let advantage =
    !!input.advantage ||
    fxAttacker.attackRollAdvantage ||
    fxTarget.incomingAttackAdvantage ||
    (meleeWithin5 && fxTarget.incomingMeleeWithin5ftAdvantage);

  let disadvantage =
    !!input.disadvantage ||
    fxAttacker.attackRollDisadvantage ||
    fxTarget.incomingAttackDisadvantage ||
    (!!input.ranged && fxTarget.incomingRangedDisadvantage);

  // PHB §1.3: any number of ADV + any number of DIS → straight roll.
  if (advantage && disadvantage) {
    advantage = false;
    disadvantage = false;
  }

  const bonus = attackBonus(input.attacker, { profGroup: input.weapon.profGroup, useDex: input.weapon.useDex });
  const attackRoll = rollD20({ advantage, disadvantage, modifier: bonus }, rng);

  const natural = attackRoll.rolls.length === 1
    ? attackRoll.rolls[0]!
    : advantage ? Math.max(...attackRoll.rolls) : Math.min(...attackRoll.rolls);

  if (natural === 1) {
    return { ok: false, error: 'miss', data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 }, rolls: [attackRoll], mutations: [] };
  }
  const naturalCrit = natural === 20;
  const hit = naturalCrit || attackRoll.total >= input.target.ac;
  if (!hit) {
    return { ok: false, error: 'miss', data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 }, rolls: [attackRoll], mutations: [] };
  }

  // Auto-crit when target is paralyzed/unconscious within 5ft melee (PHB Appendix A).
  const autoCrit = meleeWithin5 && fxTarget.incomingMeleeWithin5ftAutoCrit;
  const crit = naturalCrit || autoCrit;

  const damageMod = abilityModifier(input.weapon.useDex ? input.attacker.abilities.DEX : input.attacker.abilities.STR);
  const damageFormula = `${input.weapon.damage}${damageMod >= 0 ? '+' : ''}${damageMod}`;
  const damageRoll = rollDamage(damageFormula, { crit }, rng);
  const rawDamage = Math.max(0, damageRoll.total);
  const finalDamage = applyDamageModifiers(rawDamage, input.weapon.damageType, input.target);

  // Knockout path: melee only, requires hit, requires would-reduce-to-≤0.
  if (input.knockOut && isMelee) {
    const targetHpBefore = input.targetRuntime?.hpCurrent ?? input.target.hpMax;
    if (targetHpBefore - finalDamage <= 0) {
      const mutations: Mutation[] = [
        { op: 'set_hp', actorId: input.target.id, hpCurrent: 0 },
        {
          op: 'add_condition',
          actorId: input.target.id,
          condition: {
            slug: 'unconscious',
            source: 'knock-out blow',
            durationRounds: 'until_removed',
            appliedRound: 0,
          },
        },
      ];
      return {
        ok: true,
        data: { hit: true, crit, rawDamage, finalDamage, knockedOut: true },
        rolls: [attackRoll, damageRoll],
        mutations,
      };
    }
  }

  const mutations: Mutation[] = [];
  if (finalDamage > 0) {
    mutations.push({ op: 'apply_damage', actorId: input.target.id, amount: finalDamage, type: input.weapon.damageType });
  }

  return {
    ok: true,
    data: { hit: true, crit, rawDamage, finalDamage },
    rolls: [attackRoll, damageRoll],
    mutations,
  };
}

function applyDamageModifiers(amount: number, type: DamageType, target: CombatActor): number {
  if (target.immunities.includes(type)) return 0;
  if (target.resistances.includes(type)) return Math.floor(amount / 2);
  if (target.vulnerabilities.includes(type)) return amount * 2;
  return amount;
}
