import type { WizardState } from './types';

export interface OptionSlugs {
  raceSlugs: string[];
  classSlugs: string[];
  backgroundSlugs: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateWizardState(w: WizardState, opts: OptionSlugs): ValidationResult {
  const errors: string[] = [];
  if (!w.raceSlug) errors.push('race-required');
  else if (!opts.raceSlugs.includes(w.raceSlug)) errors.push('race-unknown');
  if (!w.classSlug) errors.push('class-required');
  else if (!opts.classSlugs.includes(w.classSlug)) errors.push('class-unknown');
  if (!w.backgroundSlug) errors.push('background-required');
  else if (!opts.backgroundSlugs.includes(w.backgroundSlug)) errors.push('background-unknown');
  if (!w.identity.name.trim()) errors.push('name-required');
  for (const v of Object.values(w.abilities)) {
    if (v < 3 || v > 18) {
      errors.push('ability-out-of-range');
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}
