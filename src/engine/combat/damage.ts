import type { ActionResult, ActorRuntimeState, CombatActor, Character, DamageType, Mutation } from '../types';
import { concentrationCheckDC } from '../spells/concentration';

export interface ApplyDamageInput {
  runtime?: ActorRuntimeState;
  target: CombatActor | Character;
  amount: number;
  type: DamageType;
  /** True when the damage source is a critical hit (PHB §3.18 → 2 fails at 0 HP). */
  isCrit?: boolean;
  /**
   * Current combat round, used to stamp `appliedRound` on the unconscious
   * condition emitted by the §3.17 massive-damage branch. Defaults to 0 if
   * not supplied (out-of-combat damage).
   */
  currentRound?: number;
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

/**
 * PHB §8.8 concentration cascade. Returns the mutation(s) to append to the
 * damage result for a concentrating target. Callers pass the post-resistance
 * `finalDamage` and pre-decided fate flags so we don't re-derive them.
 */
function concentrationMutations(
  runtime: ActorRuntimeState | undefined,
  finalDamage: number,
  willBeKilled: boolean,
  willGoToZero: boolean,
): Mutation[] {
  if (!runtime?.concentratingOn) return [];
  if (finalDamage <= 0) return [];
  if (willBeKilled) {
    return [{ op: 'break_concentration', actorId: runtime.actorId, reason: 'killed' }];
  }
  if (willGoToZero) {
    return [{ op: 'break_concentration', actorId: runtime.actorId, reason: 'incapacitated' }];
  }
  return [
    {
      op: 'concentration_check',
      actorId: runtime.actorId,
      dc: concentrationCheckDC(finalDamage),
      spellSlug: runtime.concentratingOn.spellSlug,
    },
  ];
}

export function applyDamage(input: ApplyDamageInput): ActionResult<{ newHp: number; newTempHp: number; dying?: boolean; dead?: boolean }> {
  const adjusted = modifyForResistance(input.amount, input.type, input.target);

  // ── PHB §3.17–3.18: damage while already at 0 HP ──
  // If the target is a PC and currently at 0 HP, do not subtract HP again;
  // instead, either declare instant death (massive damage) or emit
  // death_save failure mutations.
  const currentHp = input.runtime?.hpCurrent ?? input.target.hpMax;
  if (isPc(input.target) && adjusted > 0 && currentHp <= 0) {
    const targetId = input.runtime?.actorId ?? input.target.id;
    // §3.17 — single-source damage ≥ hpMax → instant death.
    if (adjusted >= input.target.hpMax) {
      const baseMuts: Mutation[] = [
        { op: 'set_hp', actorId: targetId, hpCurrent: 0 },
        {
          op: 'add_condition',
          actorId: targetId,
          condition: {
            slug: 'unconscious',
            source: 'massive damage',
            durationRounds: 'until_removed',
            appliedRound: input.currentRound ?? 0,
          },
        },
      ];
      // Per §8.8: a concentrating creature reduced to 0 HP by massive damage
      // loses concentration with reason='killed'. Already at 0 HP though, so
      // they shouldn't be holding concentration in practice; emit defensively.
      const concMuts = concentrationMutations(
        input.runtime,
        adjusted,
        true,    // killed
        false,
      );
      return {
        ok: true,
        data: { newHp: 0, newTempHp: input.runtime?.tempHp ?? 0, dead: true },
        rolls: [],
        mutations: [...baseMuts, ...concMuts],
      };
    }
    // §3.18 — +1 failure (+2 on crit).
    const fails = input.isCrit ? 2 : 1;
    const dsMutations: Mutation[] = Array.from({ length: fails }, () => ({
      op: 'death_save' as const,
      actorId: targetId,
      success: false,
      isCrit: input.isCrit ?? false,
    }));
    // No concentration mutation here: an unconscious PC can't be concentrating.
    return {
      ok: true,
      data: { newHp: 0, newTempHp: input.runtime?.tempHp ?? 0, dying: true },
      rolls: [],
      mutations: dsMutations,
    };
  }

  // ── Standard damage path (HP > 0, or non-PC) ──
  const runtime = input.runtime;
  if (!runtime) {
    // No runtime supplied and not in the at-0-HP branch — return a no-op
    // result so callers that omit runtime still type-check. Existing callers
    // always pass runtime, so this branch is defensive only.
    return {
      ok: true,
      data: { newHp: input.target.hpMax, newTempHp: 0 },
      rolls: [],
      mutations: [],
    };
  }

  let remaining = adjusted;
  let newTempHp = runtime.tempHp;
  if (newTempHp > 0) {
    const absorbed = Math.min(newTempHp, remaining);
    newTempHp -= absorbed;
    remaining -= absorbed;
  }
  const newHp = Math.max(0, runtime.hpCurrent - remaining);

  const mutations: Mutation[] = [];
  if (newTempHp !== runtime.tempHp) {
    mutations.push({ op: 'set_temp_hp', actorId: runtime.actorId, amount: newTempHp });
  }
  if (newHp !== runtime.hpCurrent) {
    mutations.push({ op: 'set_hp', actorId: runtime.actorId, hpCurrent: newHp });
  }

  let dying = false;
  let dead = false;
  if (newHp === 0 && isPc(input.target)) {
    const overflow = remaining - runtime.hpCurrent;
    if (overflow >= input.target.hpMax) {
      dead = true;
    } else {
      dying = true;
    }
  }

  // PHB §8.8 cascade for concentrating targets along the standard path.
  // Damage that would incapacitate (HP → 0) breaks concentration without a
  // save; instant-death damage breaks with reason='killed'; otherwise emit a
  // concentration_check with DC = max(10, ⌊damage/2⌋).
  const willGoToZero = newHp === 0 && runtime.hpCurrent > 0 && !dead;
  const concMuts = concentrationMutations(
    runtime,
    adjusted,
    dead,
    willGoToZero,
  );
  mutations.push(...concMuts);

  return {
    ok: true,
    data: { newHp, newTempHp, dying, dead },
    rolls: [],
    mutations,
  };
}
