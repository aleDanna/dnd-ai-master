import type { ActionResult, Character, CombatActor, DamageType, Mutation } from '../types';
import { attackBonus, abilityModifier } from '../modifiers';
import { rollD20, rollDamage } from '../dice';
import { defaultRng, type Rng } from '../rand';

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
}

export function makeAttack(input: MakeAttackInput, rng: Rng = defaultRng): ActionResult<{ hit: boolean; crit: boolean; rawDamage: number; finalDamage: number }> {
  const bonus = attackBonus(input.attacker, { profGroup: input.weapon.profGroup, useDex: input.weapon.useDex });
  const attackRoll = rollD20({ advantage: input.advantage, disadvantage: input.disadvantage, modifier: bonus }, rng);

  const natural = attackRoll.rolls.length === 1
    ? attackRoll.rolls[0]!
    : input.advantage ? Math.max(...attackRoll.rolls) : Math.min(...attackRoll.rolls);

  if (natural === 1) {
    return { ok: false, error: 'miss', data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 }, rolls: [attackRoll], mutations: [] };
  }
  const crit = natural === 20;
  const hit = crit || attackRoll.total >= input.target.ac;
  if (!hit) {
    return { ok: false, error: 'miss', data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 }, rolls: [attackRoll], mutations: [] };
  }

  const damageMod = abilityModifier(input.weapon.useDex ? input.attacker.abilities.DEX : input.attacker.abilities.STR);
  const damageFormula = `${input.weapon.damage}${damageMod >= 0 ? '+' : ''}${damageMod}`;
  const damageRoll = rollDamage(damageFormula, { crit }, rng);
  const rawDamage = Math.max(0, damageRoll.total);

  const finalDamage = applyDamageModifiers(rawDamage, input.weapon.damageType, input.target);
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
