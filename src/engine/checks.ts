import type { Ability, ActionResult, ActorRuntimeState, Character, Skill } from './types';
import { abilityModifier, savingThrowBonus, skillBonus, passiveScore } from './modifiers';
import { rollD20 } from './dice';
import { defaultRng, type Rng } from './rand';
import { getEffectsForActor } from './condition-effects';

export interface AbilityCheckInput {
  char: Character;
  skill?: Skill;
  ability?: Ability;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
  /** Optional runtime state — when present, the resolver applies condition/exhaustion effects. */
  runtime?: ActorRuntimeState;
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
  const fx = getEffectsForActor(input.runtime?.conditions ?? [], {
    exhaustionLevel: input.runtime?.exhaustionLevel,
  });
  const advantage = !!input.advantage;
  const disadvantage = !!input.disadvantage || fx.abilityCheckDisadvantage;
  const roll = rollD20({ advantage, disadvantage, modifier }, rng);
  return {
    ok: roll.total >= input.dc,
    data: { dc: input.dc },
    rolls: [roll],
    mutations: [],
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
}

export function savingThrow(
  input: SavingThrowInput,
  rng: Rng = defaultRng,
): ActionResult<{ dc: number; autoFailed?: boolean }> {
  const fx = getEffectsForActor(input.runtime?.conditions ?? [], {
    exhaustionLevel: input.runtime?.exhaustionLevel,
  });
  if (fx.saveAutoFail[input.ability]) {
    return {
      ok: false,
      data: { dc: input.dc, autoFailed: true },
      rolls: [],
      mutations: [],
    };
  }
  const modifier = savingThrowBonus(input.char, input.ability);
  const advantage = !!input.advantage;
  const disadvantage = !!input.disadvantage || fx.saveDisadvantage[input.ability];
  const roll = rollD20({ advantage, disadvantage, modifier }, rng);
  return {
    ok: roll.total >= input.dc,
    data: { dc: input.dc },
    rolls: [roll],
    mutations: [],
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
