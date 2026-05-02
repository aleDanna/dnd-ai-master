import type { DiceRoll } from './types';
import { defaultRng, type Rng } from './rand';

const FORMULA_RE = /^(\d+)d(\d+)([+-]\d+)?$/i;

function parseFormula(formula: string): { count: number; size: number; modifier: number } {
  const m = FORMULA_RE.exec(formula.trim());
  if (!m) throw new Error(`rollDice: bad formula "${formula}"`);
  const count = parseInt(m[1]!, 10);
  const size = parseInt(m[2]!, 10);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  if (count <= 0) throw new Error(`rollDice: count must be > 0 (got ${count})`);
  if (size <= 0) throw new Error(`rollDice: size must be > 0 (got ${size})`);
  return { count, size, modifier };
}

export function rollDice(formula: string, rng: Rng = defaultRng): DiceRoll {
  const { count, size, modifier } = parseFormula(formula);
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(rng.intInclusive(1, size));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { formula, rolls, modifier, total };
}

export interface D20Options {
  advantage?: boolean;
  disadvantage?: boolean;
  modifier?: number;
}

export function rollD20(opts: D20Options = {}, rng: Rng = defaultRng): DiceRoll {
  const adv = !!opts.advantage && !opts.disadvantage;
  const dis = !!opts.disadvantage && !opts.advantage;
  const modifier = opts.modifier ?? 0;
  const rolls: number[] = [];
  if (adv || dis) {
    rolls.push(rng.intInclusive(1, 20));
    rolls.push(rng.intInclusive(1, 20));
  } else {
    rolls.push(rng.intInclusive(1, 20));
  }
  const chosen = adv ? Math.max(...rolls) : dis ? Math.min(...rolls) : rolls[0]!;
  const total = chosen + modifier;
  const meta: Record<string, unknown> = {};
  if (adv) meta.advantage = true;
  if (dis) meta.disadvantage = true;
  return {
    formula: `1d20${modifier ? (modifier > 0 ? '+' : '') + modifier : ''}`,
    rolls,
    modifier,
    total,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

export interface DamageOptions {
  crit?: boolean;
}

export function rollDamage(formula: string, opts: DamageOptions = {}, rng: Rng = defaultRng): DiceRoll {
  const { count, size, modifier } = parseFormula(formula);
  const effectiveCount = opts.crit ? count * 2 : count;
  const rolls: number[] = [];
  for (let i = 0; i < effectiveCount; i++) rolls.push(rng.intInclusive(1, size));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return {
    formula,
    rolls,
    modifier,
    total,
    ...(opts.crit ? { meta: { crit: true } } : {}),
  };
}
