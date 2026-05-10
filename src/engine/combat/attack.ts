import type { ActionResult, ActorRuntimeState, Character, CombatActor, ConditionInstance, CoverLevel, DamageType, Mutation } from '../types';
import { attackBonus, abilityModifier } from '../modifiers';
import { rollD20, rollDamage } from '../dice';
import { defaultRng, type Rng } from '../rand';
import { getEffectsForActor } from '../condition-effects';
import { canConsumeAction } from './turn-state';
import { coverAcBonus, isTotalCover } from './cover';

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
  /** PHB §3.9: an opportunity attack consumes the attacker's reaction, not their action. */
  useReaction?: boolean;
  /**
   * PHB §10 Extra Attack / monster Multiattack: when true, this attack is a
   * follow-up of an Attack action already started this turn. Skips the action
   * budget check and the `consume_action` emission. The Master is responsible
   * for enforcing the per-class attack-count limit (Fighter L5: 2, L11: 3,
   * L20: 4; Barbarian/Paladin/Ranger L5: 2; monster Multiattack varies).
   */
  isExtraAttack?: boolean;
  /**
   * PHB §18.1: when true the attacker spends their Inspiration to gain ADV
   * on this attack roll (consumed regardless of outcome). Errors with
   * 'no_inspiration' if the attacker doesn't have Inspiration to spend.
   */
  useInspiration?: boolean;
  /**
   * PHB §3.12: degree of cover protecting the target. half/three-quarters
   * add +2/+5 to effective AC; 'total' short-circuits with
   * 'target_in_total_cover' WITHOUT consuming the action.
   */
  cover?: CoverLevel;
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

  // PHB §3.12 — total cover means the target cannot be targeted at all.
  // Short-circuit BEFORE consuming any action: the attacker doesn't even
  // get to try the attack.
  if (isTotalCover(input.cover)) {
    return {
      ok: false,
      error: 'target_in_total_cover',
      rolls: [],
      mutations: [],
    };
  }

  // PHB §18.1 Inspiration. The caller flags `useInspiration: true` to spend
  // the attacker's Inspiration for ADV on this roll. Reject early when the
  // attacker doesn't actually have Inspiration to spend — no rolls happen,
  // no mutations are emitted, the caller knows to drop the flag.
  if (input.useInspiration && !input.attacker.inspiration) {
    return { ok: false, error: 'no_inspiration', rolls: [], mutations: [] };
  }
  // When valid, the attacker gets ADV and we emit the spend mutation on
  // every exit path below (the spend is consumed regardless of outcome —
  // PHB: "spend Inspiration to gain advantage on one attack").
  const spendInspirationMut: Mutation | null = input.useInspiration
    ? { op: 'spend_inspiration', characterId: input.attacker.id }
    : null;

  // Action-economy budget check (PHB §3.9). Skipped if attacker has no turnState
  // (backward compat for callers that don't yet track action economy). Also
  // skipped when this is an Extra Attack / Multiattack follow-up: PHB §10 says
  // a single Attack action grants multiple swings, so the budget was already
  // paid by the first attack of the turn.
  const attackerTurnState = input.attackerRuntime?.turnState;
  const actionKind: 'action' | 'reaction' = input.useReaction ? 'reaction' : 'action';
  if (
    !input.isExtraAttack &&
    attackerTurnState &&
    !canConsumeAction(attackerTurnState, actionKind)
  ) {
    return {
      ok: false,
      error: actionKind === 'reaction' ? 'reaction_already_used' : 'action_already_used',
      rolls: [],
      mutations: [],
    };
  }

  // Build a consume_action mutation when (and only when) the attacker tracks
  // turnState AND this is not an Extra Attack follow-up.
  const consumeActionMut: Mutation | null =
    !input.isExtraAttack && attackerTurnState
      ? { op: 'consume_action', actorId: input.attacker.id, kind: actionKind }
      : null;

  // PHB §3.5 Help: a 'helped' beneficiary gets ADV on the next d20 (consumed
  // on first use, regardless of hit/miss). Detect on the attacker, and
  // schedule a remove_condition mutation in the result paths below.
  const helpedAttacker = (input.attackerRuntime?.conditions ?? []).some(
    (c) => c.slug === 'helped',
  );
  const consumeHelpedMut: Mutation | null = helpedAttacker
    ? { op: 'remove_condition', actorId: input.attacker.id, conditionSlug: 'helped' }
    : null;

  // Target dodging (PHB §3.7) imposes DIS on attacks against it (until next turn).
  const targetDodging = input.targetRuntime?.turnState?.dodging ?? false;

  const isMelee = !input.ranged;
  const meleeWithin5 = isMelee && (input.meleeRange ?? 5) <= 5;

  // OR all sources of advantage / disadvantage.
  let advantage =
    !!input.advantage ||
    !!input.useInspiration ||
    fxAttacker.attackRollAdvantage ||
    fxTarget.incomingAttackAdvantage ||
    (meleeWithin5 && fxTarget.incomingMeleeWithin5ftAdvantage) ||
    helpedAttacker;

  let disadvantage =
    !!input.disadvantage ||
    fxAttacker.attackRollDisadvantage ||
    fxTarget.incomingAttackDisadvantage ||
    (!!input.ranged && fxTarget.incomingRangedDisadvantage) ||
    targetDodging;

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
    const missMuts: Mutation[] = [];
    if (consumeActionMut) missMuts.push(consumeActionMut);
    if (consumeHelpedMut) missMuts.push(consumeHelpedMut);
    if (spendInspirationMut) missMuts.push(spendInspirationMut);
    return {
      ok: false,
      error: 'miss',
      data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 },
      rolls: [attackRoll],
      mutations: missMuts,
    };
  }
  const naturalCrit = natural === 20;
  // PHB §3.12 — half/three-quarters cover bumps the effective AC by +2/+5.
  // Total cover is short-circuited above, so coverAcBonus is finite here.
  const effectiveAc = input.target.ac + coverAcBonus(input.cover ?? 'none');
  const hit = naturalCrit || attackRoll.total >= effectiveAc;
  if (!hit) {
    const missMuts: Mutation[] = [];
    if (consumeActionMut) missMuts.push(consumeActionMut);
    if (consumeHelpedMut) missMuts.push(consumeHelpedMut);
    if (spendInspirationMut) missMuts.push(spendInspirationMut);
    return {
      ok: false,
      error: 'miss',
      data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 },
      rolls: [attackRoll],
      mutations: missMuts,
    };
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
      if (consumeActionMut) mutations.push(consumeActionMut);
      if (consumeHelpedMut) mutations.push(consumeHelpedMut);
      if (spendInspirationMut) mutations.push(spendInspirationMut);
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
  if (consumeActionMut) mutations.push(consumeActionMut);
  if (consumeHelpedMut) mutations.push(consumeHelpedMut);
  if (spendInspirationMut) mutations.push(spendInspirationMut);

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
