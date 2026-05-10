import type { Ability, ActionResult, ActorRuntimeState, Character, CoverLevel, Mutation, Skill } from './types';
import { abilityModifier, savingThrowBonus, skillBonus, passiveScore } from './modifiers';
import { rollD20 } from './dice';
import { defaultRng, type Rng } from './rand';
import { getEffectsForActor } from './condition-effects';
import { coverDexSaveBonus } from './combat/cover';

export interface AbilityCheckInput {
  char: Character;
  skill?: Skill;
  ability?: Ability;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
  /** Optional runtime state — when present, the resolver applies condition/exhaustion effects. */
  runtime?: ActorRuntimeState;
  /**
   * PHB §18.1: when true the PC spends Inspiration for ADV on this check
   * (consumed regardless of outcome). Errors with 'no_inspiration' if the
   * PC doesn't have Inspiration.
   */
  useInspiration?: boolean;
}

export function abilityCheck(input: AbilityCheckInput, rng: Rng = defaultRng): ActionResult<{ dc: number }> {
  let modifier = 0;
  if (input.skill) {
    modifier = skillBonus(input.char, input.skill);
  } else if (input.ability) {
    modifier = abilityModifier(input.char.abilities[input.ability]);
  } else {
    return { ok: false, error: 'abilityCheck: must provide skill or ability', rolls: [], mutations: [] };
  }
  // PHB §18.1: validate Inspiration presence before rolling — no rolls
  // happen on a no_inspiration error.
  if (input.useInspiration && !input.char.inspiration) {
    return { ok: false, error: 'no_inspiration', rolls: [], mutations: [] };
  }
  const fx = getEffectsForActor(input.runtime?.conditions ?? [], {
    exhaustionLevel: input.runtime?.exhaustionLevel,
  });
  // PHB §3.5 Help: a 'helped' beneficiary gets ADV on the next d20 (consumed
  // on first use, regardless of pass/fail). Detect on the runtime here.
  const helpedActor = (input.runtime?.conditions ?? []).some((c) => c.slug === 'helped');
  const advantage = !!input.advantage || helpedActor || !!input.useInspiration;
  const disadvantage = !!input.disadvantage || fx.abilityCheckDisadvantage;
  const roll = rollD20({ advantage, disadvantage, modifier }, rng);
  const mutations: Mutation[] = [];
  if (helpedActor) {
    mutations.push({
      op: 'remove_condition',
      actorId: input.char.id,
      conditionSlug: 'helped',
    });
  }
  if (input.useInspiration) {
    // Spend regardless of outcome — PHB: "spend Inspiration to gain ADV on
    // ONE roll" (consumed on first use).
    mutations.push({ op: 'spend_inspiration', characterId: input.char.id });
  }
  return {
    ok: roll.total >= input.dc,
    data: { dc: input.dc },
    rolls: [roll],
    mutations,
  };
}

export interface SavingThrowInput {
  char: Character;
  ability: Ability;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
  /** Optional runtime state — when present, the resolver applies condition/exhaustion effects. */
  runtime?: ActorRuntimeState;
  /**
   * PHB §18.1: when true the PC spends Inspiration for ADV on this save
   * (consumed regardless of outcome). Errors with 'no_inspiration' if the
   * PC doesn't have Inspiration.
   */
  useInspiration?: boolean;
  /**
   * PHB §3.12 — cover behind which the saver sits when the AoE originates
   * from the OTHER side of that cover (e.g. fireball through a doorway).
   * Adds the cover bonus (+2/+5) to the save modifier ONLY when ability
   * is 'DEX'. Other abilities ignore cover.
   */
  cover?: CoverLevel;
}

export function savingThrow(
  input: SavingThrowInput,
  rng: Rng = defaultRng,
): ActionResult<{ dc: number; autoFailed?: boolean }> {
  // Validate Inspiration first — no rolls happen on a no_inspiration error
  // (and we don't want to short-circuit through the auto-fail branch with
  // an invalid use claim).
  if (input.useInspiration && !input.char.inspiration) {
    return { ok: false, error: 'no_inspiration', rolls: [], mutations: [] };
  }
  const fx = getEffectsForActor(input.runtime?.conditions ?? [], {
    exhaustionLevel: input.runtime?.exhaustionLevel,
  });
  if (fx.saveAutoFail[input.ability]) {
    // PHB: even if the save auto-fails (e.g. STR/DEX while paralyzed),
    // spending Inspiration on it still consumes the resource — the player
    // declared the spend before learning about the auto-fail. Mirror that.
    const muts: Mutation[] = [];
    if (input.useInspiration) {
      muts.push({ op: 'spend_inspiration', characterId: input.char.id });
    }
    return {
      ok: false,
      data: { dc: input.dc, autoFailed: true },
      rolls: [],
      mutations: muts,
    };
  }
  // PHB §3.12 — cover bonus applies to DEX saves only. For other abilities
  // the bonus is silently ignored (cover doesn't help against a domination
  // spell or a poison spreading through your bloodstream).
  const coverBonus =
    input.ability === 'DEX' && input.cover ? coverDexSaveBonus(input.cover) : 0;
  const modifier = savingThrowBonus(input.char, input.ability) + coverBonus;
  const advantage = !!input.advantage || !!input.useInspiration;
  const disadvantage = !!input.disadvantage || fx.saveDisadvantage[input.ability];
  const roll = rollD20({ advantage, disadvantage, modifier }, rng);
  const mutations: Mutation[] = [];
  if (input.useInspiration) {
    mutations.push({ op: 'spend_inspiration', characterId: input.char.id });
  }
  return {
    ok: roll.total >= input.dc,
    data: { dc: input.dc },
    rolls: [roll],
    mutations,
  };
}

export interface ContestSide {
  char: Character;
  skill?: Skill;
  ability?: Ability;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function contestedCheck(
  a: ContestSide,
  b: ContestSide,
  rng: Rng = defaultRng,
): ActionResult<{ winner: 'a' | 'b' | 'tie' }> {
  const rA = abilityCheck({ char: a.char, skill: a.skill, ability: a.ability, dc: 0, advantage: a.advantage, disadvantage: a.disadvantage }, rng);
  const rB = abilityCheck({ char: b.char, skill: b.skill, ability: b.ability, dc: 0, advantage: b.advantage, disadvantage: b.disadvantage }, rng);
  const ta = rA.rolls[0]!.total;
  const tb = rB.rolls[0]!.total;
  const winner: 'a' | 'b' | 'tie' = ta > tb ? 'a' : tb > ta ? 'b' : 'tie';
  return {
    ok: winner !== 'tie',
    data: { winner },
    rolls: [...rA.rolls, ...rB.rolls],
    mutations: [],
  };
}

export interface PassiveCheckInput {
  char: Character;
  skill: Skill;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function passiveCheck(input: PassiveCheckInput): ActionResult<{ passive: number }> {
  const passive = passiveScore(input.char, input.skill, { advantage: input.advantage, disadvantage: input.disadvantage });
  return {
    ok: true,
    data: { passive },
    rolls: [{ formula: 'passive', rolls: [], modifier: 0, total: passive, meta: { passive: true, skill: input.skill } }],
    mutations: [],
  };
}

export interface GroupCheckInput {
  chars: Character[];
  skill: Skill;
  dc: number;
}

export function groupCheck(input: GroupCheckInput, rng: Rng = defaultRng): ActionResult<{ successes: number; needed: number }> {
  const rolls = input.chars.map((c) => rollD20({ modifier: skillBonus(c, input.skill) }, rng));
  const successes = rolls.filter((r) => r.total >= input.dc).length;
  const needed = Math.ceil(input.chars.length / 2);
  return {
    ok: successes >= needed,
    data: { successes, needed },
    rolls,
    mutations: [],
  };
}
