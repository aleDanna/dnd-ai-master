import type { Skill } from '@/engine/types';

const ALL_SKILLS: ReadonlySet<string> = new Set<Skill>([
  'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics',
  'Deception', 'History', 'Insight', 'Intimidation',
  'Investigation', 'Medicine', 'Nature', 'Perception',
  'Performance', 'Persuasion', 'Religion', 'Sleight of Hand',
  'Stealth', 'Survival',
]);

const ALIGNMENTS: ReadonlySet<string> = new Set([
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
]);

export interface OptionSlugs {
  raceSlugs: string[];
  classSlugs: string[];
  backgroundSlugs: string[];
}

export interface ProposalShape {
  step: string;
  value: unknown;
  reasoning: string;
}

export type ValidationOutcome = { ok: true } | { ok: false; error: string };

export function validateProposal(p: ProposalShape, opts: OptionSlugs): ValidationOutcome {
  if (typeof p.reasoning !== 'string') return { ok: false, error: 'reasoning must be string' };
  switch (p.step) {
    case 'race':
      return validateSlug(p.value, opts.raceSlugs, 'race');
    case 'class':
      return validateSlug(p.value, opts.classSlugs, 'class');
    case 'background':
      return validateSlug(p.value, opts.backgroundSlugs, 'background');
    case 'abilities':
      return validateAbilities(p.value);
    case 'skills':
      return validateSkills(p.value);
    case 'equipment':
      return p.value === 'kit' || p.value === 'gold' ? { ok: true } : { ok: false, error: 'equipment must be "kit" or "gold"' };
    case 'identity':
      return validateIdentity(p.value);
    default:
      return { ok: false, error: `unknown step "${p.step}"` };
  }
}

function validateSlug(v: unknown, allowed: string[], label: string): ValidationOutcome {
  if (typeof v !== 'string') return { ok: false, error: `${label} must be a string` };
  if (!allowed.includes(v)) return { ok: false, error: `${label} "${v}" not in SRD` };
  return { ok: true };
}

function validateAbilities(v: unknown): ValidationOutcome {
  if (!v || typeof v !== 'object') return { ok: false, error: 'abilities must be an object' };
  const o = v as Record<string, unknown>;
  for (const k of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 3 || n > 18) {
      return { ok: false, error: `${k} must be integer in [3, 18]` };
    }
  }
  return { ok: true };
}

function validateSkills(v: unknown): ValidationOutcome {
  if (!Array.isArray(v)) return { ok: false, error: 'skills must be an array' };
  for (const s of v) {
    if (typeof s !== 'string' || !ALL_SKILLS.has(s)) return { ok: false, error: `unknown skill "${String(s)}"` };
  }
  return { ok: true };
}

function validateIdentity(v: unknown): ValidationOutcome {
  if (!v || typeof v !== 'object') return { ok: false, error: 'identity must be an object' };
  const o = v as Record<string, unknown>;
  for (const k of ['name', 'alignment', 'trait', 'bond', 'flaw', 'backstory']) {
    if (k in o && typeof o[k] !== 'string') return { ok: false, error: `identity.${k} must be a string` };
  }
  if (o.alignment && typeof o.alignment === 'string' && !ALIGNMENTS.has(o.alignment)) {
    return { ok: false, error: `unknown alignment "${o.alignment}"` };
  }
  return { ok: true };
}
