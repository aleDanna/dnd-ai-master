import type { WizardState } from './types';
import {
  isCompletePointBuy,
  isCompleteStandardArray,
  pointBuySpent,
} from './abilities-rules';
import { POINT_BUY_BUDGET, POINT_BUY_MAX, POINT_BUY_MIN } from './types';
import { getClassChoices } from '@/srd/class-l1-choices';

export interface OptionSlugs {
  raceSlugs: string[];
  classSlugs: string[];
  backgroundSlugs: string[];
  /**
   * Map base race slug → list of subrace slugs. When the selected race has
   * one or more entries, the wizard MUST also pick `subraceSlug` from that
   * list (otherwise the rule data — racial ASI, traits, languages — is
   * ambiguous).
   */
  subracesByBase?: Record<string, string[]>;
  /** Optional: per-class skill rules. When provided, skill picks are validated against them. */
  classSkillRules?: Record<string, { skillsChoose: number; skillsFrom: string[] }>;
  /** Optional: per-background skill grants. When provided, ensures grants don't double-count. */
  backgroundSkills?: Record<string, string[]>;
  /** Known feat slugs (from `srd_feat`). When provided, picks are checked against this set. */
  featSlugs?: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateWizardState(w: WizardState, opts: OptionSlugs): ValidationResult {
  const errors: string[] = [];
  if (!w.raceSlug) errors.push('race-required');
  else if (!opts.raceSlugs.includes(w.raceSlug)) errors.push('race-unknown');
  // Subrace requirement: if the selected base race has subraces, one must be picked.
  if (w.raceSlug && opts.subracesByBase) {
    const subraces = opts.subracesByBase[w.raceSlug] ?? [];
    if (subraces.length > 0) {
      if (!w.subraceSlug) errors.push('subrace-required');
      else if (!subraces.includes(w.subraceSlug)) errors.push('subrace-unknown');
    } else if (w.subraceSlug) {
      errors.push('subrace-not-applicable');
    }
  }
  if (!w.classSlug) errors.push('class-required');
  else if (!opts.classSlugs.includes(w.classSlug)) errors.push('class-unknown');
  if (!w.backgroundSlug) errors.push('background-required');
  else if (!opts.backgroundSlugs.includes(w.backgroundSlug)) errors.push('background-unknown');
  if (!w.identity.name.trim()) errors.push('name-required');

  // Range guard for any method.
  for (const v of Object.values(w.abilities)) {
    if (v < 3 || v > 18) {
      errors.push('ability-out-of-range');
      break;
    }
  }

  // Method-specific constraints.
  if (w.abilityMethod === 'array') {
    if (!isCompleteStandardArray(w.abilities)) errors.push('ability-array-mismatch');
  } else if (w.abilityMethod === 'pointbuy') {
    for (const v of Object.values(w.abilities)) {
      if (v < POINT_BUY_MIN || v > POINT_BUY_MAX) {
        errors.push('ability-pointbuy-range');
        break;
      }
    }
    const spent = pointBuySpent(w.abilities);
    if (spent > POINT_BUY_BUDGET) errors.push('ability-pointbuy-overspent');
    else if (!isCompletePointBuy(w.abilities)) errors.push('ability-pointbuy-incomplete');
  }
  // 'roll' mode is validated client-side against the locally-generated pool;
  // server-side we only enforce the 3..18 range above.

  // Feats: each picked slug must exist in the catalog and be unique. The cap
  // is enforced UI-side (see `computeFeatCap` in wizard-client) — we don't
  // re-derive it here because race/class flag wiring is the wizard's job.
  // Server-side this guarantees no junk slug sneaks in via a hand-crafted POST.
  if (w.feats && w.feats.length > 0) {
    const seen = new Set<string>();
    for (const slug of w.feats) {
      if (seen.has(slug)) errors.push('feats-duplicated');
      seen.add(slug);
      if (opts.featSlugs && !opts.featSlugs.includes(slug)) errors.push(`feat-unknown:${slug}`);
    }
  }

  // Class L1 choices: every defined choice for the class must be picked from
  // the option list. Skipped quietly if classSlug is missing/unknown (other
  // checks above will already flag those).
  if (w.classSlug) {
    const required = getClassChoices(w.classSlug);
    for (const choice of required) {
      const picked = w.classChoices[choice.key];
      if (!picked) {
        errors.push(`class-choice-required:${choice.key}`);
      } else if (!choice.options.some((o) => o.slug === picked)) {
        errors.push(`class-choice-unknown:${choice.key}`);
      }
    }
  }

  // Skill picks: enforce class budget when rules are available.
  if (w.classSlug && opts.classSkillRules) {
    const rule = opts.classSkillRules[w.classSlug];
    if (rule) {
      const bgSkills = (w.backgroundSlug && opts.backgroundSkills?.[w.backgroundSlug]) ?? [];
      const classPicks = w.skills.filter((s) => rule.skillsFrom.includes(s) && !bgSkills.includes(s));
      const offList = w.skills.filter((s) => !rule.skillsFrom.includes(s) && !bgSkills.includes(s));
      if (offList.length > 0) errors.push('skills-off-list');
      if (classPicks.length > rule.skillsChoose) errors.push('skills-too-many');
      else if (classPicks.length < rule.skillsChoose) errors.push('skills-too-few');
    }
  }

  return { ok: errors.length === 0, errors };
}
