/**
 * PHB §2.5 Multiclassing — pure helpers.
 *
 * - `MULTICLASS_PREREQS` lists, per class, the ability minimums a PC must
 *   meet to ADD that class as a new entry. AND mode requires ALL listed
 *   ability minimums; OR mode requires AT LEAST ONE.
 * - `meetsMulticlassPrereqs` validates BOTH the starting class's prereqs
 *   AND the new class's prereqs; re-leveling an existing class skips the
 *   check (the PC already has that class — only true cross-class adds
 *   trigger the gate).
 *
 * PHB §13.2 Multi-class spell slots — a multi-class caster determines
 * their slot table by combining caster levels:
 * - full caster (bard/cleric/druid/sorcerer/wizard) = level 1:1
 * - half caster (paladin/ranger) = floor(level / 2); paladin/ranger at
 *   level 1 contribute NOTHING (they don't get spells until L2)
 * - third caster (Eldritch Knight subclass of fighter, Arcane Trickster
 *   subclass of rogue) = floor(level / 3); contribution starts at L3
 * - Warlock Pact Magic is NOT combined into the multi-class slot pool.
 *
 * The combined caster level then indexes the standard full-caster slot
 * table from PHB §13.1 (verbatim below in `FULL_CASTER_SLOTS`).
 */

import type { Ability, Character, ClassLevel } from './types';

/** Prereq mode — AND requires every listed minimum; OR requires at least one. */
export type PrereqMode = 'and' | 'or';

export interface PrereqSpec {
  mode: PrereqMode;
  mins: Partial<Record<Ability, number>>;
}

/** PHB §2.5 — ability prerequisites for adding each class as a new multi-class entry. */
export const MULTICLASS_PREREQS: Record<string, PrereqSpec> = {
  barbarian: { mode: 'and', mins: { STR: 13 } },
  bard: { mode: 'and', mins: { CHA: 13 } },
  cleric: { mode: 'and', mins: { WIS: 13 } },
  druid: { mode: 'and', mins: { WIS: 13 } },
  fighter: { mode: 'or', mins: { STR: 13, DEX: 13 } },
  monk: { mode: 'and', mins: { DEX: 13, WIS: 13 } },
  paladin: { mode: 'and', mins: { STR: 13, CHA: 13 } },
  ranger: { mode: 'and', mins: { DEX: 13, WIS: 13 } },
  rogue: { mode: 'and', mins: { DEX: 13 } },
  sorcerer: { mode: 'and', mins: { CHA: 13 } },
  warlock: { mode: 'and', mins: { CHA: 13 } },
  wizard: { mode: 'and', mins: { INT: 13 } },
};

/**
 * Helper: does the character's ability scores satisfy a single class's
 * multiclass prereq?
 */
function meetsSpec(abilities: Record<Ability, number>, spec: PrereqSpec): boolean {
  const checks = (Object.entries(spec.mins) as [Ability, number][]).map(
    ([ab, min]) => (abilities[ab] ?? 0) >= min,
  );
  if (checks.length === 0) return true;
  return spec.mode === 'and' ? checks.every(Boolean) : checks.some(Boolean);
}

/** Resolve the PC's starting class slug — first entry of `classes` if present, else legacy `classSlug`. */
function startingClassOf(character: Character): string {
  const fromArray = character.classes?.[0]?.slug;
  return fromArray ?? character.classSlug;
}

/** List the class slugs the PC currently has at least one level in. */
function existingClassSlugs(character: Character): string[] {
  const classes = character.classes;
  if (Array.isArray(classes) && classes.length > 0) {
    return classes.map((c) => c.slug);
  }
  // Legacy snapshot (no classes[]): the only class is `classSlug`.
  return character.classSlug ? [character.classSlug] : [];
}

/**
 * PHB §2.5 — does the character meet the multiclass prereqs for adding
 * `newClassSlug` as a new class entry?
 *
 * Rules:
 * - Re-leveling an existing class (the slug is already in `classes[]`):
 *   no prereq check, returns true.
 * - Otherwise both the starting class's prereqs AND the new class's
 *   prereqs must hold.
 * - Unknown class slugs (not in `MULTICLASS_PREREQS`) impose no constraint
 *   for that side of the check (the tool layer is responsible for slug
 *   validation).
 */
export function meetsMulticlassPrereqs(character: Character, newClassSlug: string): boolean {
  // Re-level: the PC already has at least one level in this class.
  const existing = existingClassSlugs(character);
  if (existing.includes(newClassSlug)) return true;

  const starting = startingClassOf(character);
  const startingSpec = MULTICLASS_PREREQS[starting];
  const newSpec = MULTICLASS_PREREQS[newClassSlug];

  if (startingSpec && !meetsSpec(character.abilities, startingSpec)) return false;
  if (newSpec && !meetsSpec(character.abilities, newSpec)) return false;
  return true;
}

/** PHB §13.2 — caster type per class for the multi-class slot calculation. */
export type CasterKind = 'full' | 'half' | 'third' | 'pact' | 'none';

export const CASTER_TYPE: Record<string, CasterKind> = {
  bard: 'full',
  cleric: 'full',
  druid: 'full',
  sorcerer: 'full',
  wizard: 'full',
  paladin: 'half',
  ranger: 'half',
  // Fighter and Rogue default to 'none'; the EK/AT subclasses are handled
  // explicitly inside `combinedCasterLevel` via the entry's `subclass`.
  fighter: 'none',
  rogue: 'none',
  monk: 'none',
  barbarian: 'none',
  warlock: 'pact',
};

/**
 * PHB §13.2 — combined caster level for spell-slot calculation.
 *
 * Sums each class entry's contribution:
 * - full caster: +level
 * - half caster (paladin/ranger): floor(level / 2). Note that level 1 in
 *   a half-caster class contributes 0 (paladin/ranger don't get spells
 *   until level 2; floor(1/2) = 0).
 * - third caster — Eldritch Knight subclass of fighter, Arcane Trickster
 *   subclass of rogue: floor(level / 3). EK/AT don't gain spellcasting
 *   until level 3, so level 1-2 contribute 0 (floor(1/3) = floor(2/3) = 0).
 * - Warlock Pact Magic and non-casters: 0.
 */
export function combinedCasterLevel(classes: ClassLevel[]): number {
  let total = 0;
  for (const cl of classes) {
    const kind: CasterKind = CASTER_TYPE[cl.slug] ?? 'none';
    const level = Math.max(0, Math.floor(cl.level));

    // Third-caster subclasses (Eldritch Knight / Arcane Trickster) override
    // the base 'none' classification for fighter/rogue. Per PHB §13.2 these
    // round down their levels by a third.
    const isThirdCasterSubclass =
      (cl.slug === 'fighter' && cl.subclass === 'eldritch-knight') ||
      (cl.slug === 'rogue' && cl.subclass === 'arcane-trickster');

    if (isThirdCasterSubclass) {
      total += Math.floor(level / 3);
      continue;
    }

    switch (kind) {
      case 'full':
        total += level;
        break;
      case 'half':
        // floor(level/2) — naturally yields 0 at level 1.
        total += Math.floor(level / 2);
        break;
      case 'third':
        // No class is classified 'third' by default; this branch is
        // defensive in case future content adds one. floor(level/3).
        total += Math.floor(level / 3);
        break;
      case 'pact':
      case 'none':
      default:
        // Pact Magic is tracked separately; non-casters contribute nothing.
        break;
    }
  }
  return total;
}

/**
 * PHB §13.1 — Spell Slots per Spell Level table for full casters.
 * Index 0 is unused (caster level 0 ⇒ no slots). Indices 1..20 hold
 * verbatim PHB rows mapping spell-slot level → max slots at that level.
 *
 * The same table is the lookup target for multi-class casters: compute
 * combined caster level via `combinedCasterLevel`, then read the row.
 */
const FULL_CASTER_SLOTS: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, number>>[] = [
  /* L0 unused */ {},
  /* L1  */ { 1: 2 },
  /* L2  */ { 1: 3 },
  /* L3  */ { 1: 4, 2: 2 },
  /* L4  */ { 1: 4, 2: 3 },
  /* L5  */ { 1: 4, 2: 3, 3: 2 },
  /* L6  */ { 1: 4, 2: 3, 3: 3 },
  /* L7  */ { 1: 4, 2: 3, 3: 3, 4: 1 },
  /* L8  */ { 1: 4, 2: 3, 3: 3, 4: 2 },
  /* L9  */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  /* L10 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  /* L11 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  /* L12 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  /* L13 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  /* L14 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  /* L15 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  /* L16 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  /* L17 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
  /* L18 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 },
  /* L19 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 },
  /* L20 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
];

/**
 * PHB §13.1 — slot map for a given (combined) caster level. Returns an
 * empty map for caster level <= 0 (non-caster or sub-threshold). Levels
 * above 20 clamp to the level-20 row.
 */
export function spellSlotsForCasterLevel(
  casterLevel: number,
): Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, number>> {
  if (!Number.isFinite(casterLevel) || casterLevel < 1) return {};
  const idx = Math.min(20, Math.max(1, Math.floor(casterLevel)));
  return { ...FULL_CASTER_SLOTS[idx] };
}

/** Set of class slugs the engine treats as the canonical 12 PHB classes. */
export const VALID_CLASS_SLUGS: readonly string[] = Object.keys(MULTICLASS_PREREQS);
