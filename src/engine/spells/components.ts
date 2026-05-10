import type {
  ConditionInstance,
  EquippedFocus,
  FocusKind,
  SpellComponents,
} from '../types';

/**
 * PHB §8.3 — parse a spell's components string (as stored in the SRD,
 * e.g. "V S M (a sprig of mistletoe)" or "V" or "V S M (silver dust
 * worth 25 gp)") into typed flags + an optional material description
 * + a `materialCostly` marker.
 *
 * Heuristics:
 *   - Verbal: standalone uppercase "V" anywhere in the string.
 *   - Somatic: standalone uppercase "S" anywhere in the string.
 *   - Material: standalone uppercase "M" — with or without the
 *     parenthetical description.
 *   - materialCostly: the parenthetical mentions a coin amount
 *     ("25 gp", "100 sp", …) OR the word "consumed".
 *
 * Empty / null / undefined → all flags false (no requirements).
 */
export function parseComponents(s: string | undefined | null): SpellComponents {
  const text = (s ?? '').trim();
  if (!text) {
    return { verbal: false, somatic: false, material: false };
  }
  const verbal = /\bV\b/.test(text);
  const somatic = /\bS\b/.test(text);
  const materialMatch = text.match(/\bM\b\s*\(([^)]*)\)/);
  const material = !!materialMatch || /\bM\b/.test(text);
  const materialDescription = materialMatch?.[1]?.trim();
  const materialCostly = materialDescription
    ? /\b\d+\s*(?:gp|sp|ep|cp|pp)\b/i.test(materialDescription) ||
      /consumed/i.test(materialDescription)
    : false;
  const out: SpellComponents = { verbal, somatic, material };
  if (materialDescription) out.materialDescription = materialDescription;
  if (materialCostly) out.materialCostly = true;
  return out;
}

/**
 * PHB §8.3-8.4 — input shape for `validateComponents`.
 *
 * `freeHand` — the caster has at least one free hand (no weapon or
 * shield in both). The somatic component allows EITHER a free hand
 * OR a held focus matching the caster's class.
 *
 * `equippedFocus` + `canUseFocus` — the focus replaces the somatic
 * free-hand check AND substitutes any non-costly material component.
 * Focus does NOT replace consumed/gp-priced materials (PHB §8.4: "if
 * the spell does NOT have a cost, the focus replaces it").
 *
 * `hasMaterial` — the master narratively asserts the caster has
 * the material in inventory. Defaulted true at the call site — we
 * assume the master has thought about it.
 */
export interface ValidateComponentsInput {
  components: SpellComponents;
  /** Conditions on the caster — used to detect 'silenced' for V. */
  casterConditions: ConditionInstance[];
  /** True if the caster has at least one free hand (no weapon/shield in both). */
  freeHand: boolean;
  /** Currently equipped focus, if any. */
  equippedFocus?: EquippedFocus;
  /** True if the caster has the material component in inventory. */
  hasMaterial: boolean;
  /** True if the caster's class can use the equipped focus's kind. */
  canUseFocus: boolean;
}

export type ComponentError =
  | 'silenced'
  | 'no_free_hand'
  | 'missing_material';

/**
 * PHB §8.3 — gate the cast on V/S/M components. Returns null on success
 * (all components satisfied) or a tagged error string on failure. The
 * caller (`castSpell`) translates the error into `component_<error>`.
 *
 * Order of checks (first failure wins):
 *   1. V — caster must NOT have `silenced` condition
 *   2. S — caster needs free hand OR a usable focus
 *   3. M — caster needs the material if costly; focus may replace
 *      non-costly material
 */
export function validateComponents(input: ValidateComponentsInput): ComponentError | null {
  if (
    input.components.verbal &&
    input.casterConditions.some((c) => c.slug === 'silenced')
  ) {
    return 'silenced';
  }
  if (input.components.somatic) {
    const focusInHand = !!input.equippedFocus && input.canUseFocus;
    if (!input.freeHand && !focusInHand) return 'no_free_hand';
  }
  if (input.components.material) {
    if (input.components.materialCostly) {
      if (!input.hasMaterial) return 'missing_material';
    } else {
      const focusReplaces = !!input.equippedFocus && input.canUseFocus;
      if (!focusReplaces && !input.hasMaterial) return 'missing_material';
    }
  }
  return null;
}

/**
 * PHB §8.4 — focus eligibility per class. Returns the `FocusKind` the
 * given class can wield, or null when the class doesn't have a
 * spellcasting focus (fighter, monk, rogue, barbarian).
 *
 * Mapping (PHB):
 *   - sorcerer / warlock / wizard → arcane
 *   - druid / ranger → druidic
 *   - cleric / paladin → holy
 *   - bard → instrument
 *
 * Anything else (subclass-driven half-casters, multiclass weirdness)
 * falls through and returns null — the caster can still hold a focus
 * but `canUseFocus` will be false.
 */
export function focusKindForClass(classSlug: string): FocusKind | null {
  switch (classSlug) {
    case 'sorcerer':
    case 'warlock':
    case 'wizard':
      return 'arcane';
    case 'druid':
    case 'ranger':
      return 'druidic';
    case 'cleric':
    case 'paladin':
      return 'holy';
    case 'bard':
      return 'instrument';
    default:
      return null;
  }
}
