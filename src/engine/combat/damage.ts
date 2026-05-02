import type { ActionResult, ActorRuntimeState, CombatActor, Character, DamageType, Mutation } from '../types';

export interface ApplyDamageInput {
  runtime: ActorRuntimeState;
  target: CombatActor | Character;
  amount: number;
  type: DamageType;
}

function isPc(target: CombatActor | Character): target is Character {
  return 'classSlug' in target;
}

function modifyForResistance(amount: number, type: DamageType, target: CombatActor | Character): number {
  if (isPc(target)) return amount;       // PC resistances/immunities not modeled in Plan B (covered later via gear/spells)
  if (target.immunities.includes(type)) return 0;
  if (target.resistances.includes(type)) return Math.floor(amount / 2);
  if (target.vulnerabilities.includes(type)) return amount * 2;
  return amount;
}

export function applyDamage(input: ApplyDamageInput): ActionResult<{ newHp: number; newTempHp: number; dying?: boolean; dead?: boolean }> {
  const adjusted = modifyForResistance(input.amount, input.type, input.target);
  let remaining = adjusted;
  let newTempHp = input.runtime.tempHp;
  if (newTempHp > 0) {
    const absorbed = Math.min(newTempHp, remaining);
    newTempHp -= absorbed;
    remaining -= absorbed;
  }
  const newHp = Math.max(0, input.runtime.hpCurrent - remaining);

  const mutations: Mutation[] = [];
  if (newTempHp !== input.runtime.tempHp) {
    mutations.push({ op: 'set_temp_hp', actorId: input.runtime.actorId, amount: newTempHp });
  }
  if (newHp !== input.runtime.hpCurrent) {
    mutations.push({ op: 'set_hp', actorId: input.runtime.actorId, hpCurrent: newHp });
  }

  let dying = false;
  let dead = false;
  if (newHp === 0 && isPc(input.target)) {
    const overflow = remaining - input.runtime.hpCurrent;
    if (overflow >= input.target.hpMax) {
      dead = true;
    } else {
      dying = true;
    }
  }

  return {
    ok: true,
    data: { newHp, newTempHp, dying, dead },
    rolls: [],
    mutations,
  };
}
