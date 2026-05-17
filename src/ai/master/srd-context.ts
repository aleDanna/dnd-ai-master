import { db } from '@/db/client';
import { srdRuleDoc, srdClass, srdRace, srdBackground, srdCondition } from '@/db/schema';
import { asc } from 'drizzle-orm';

let _cache: string | null = null;
let _compactCache: string | null = null;

/**
 * Top-level rule-doc sections kept in the compact build. The rest
 * (character creation, equipment subtypes, magic-item overview, class
 * summary tables, stat-block reading guide, source notes) is dropped —
 * the master rarely needs it mid-turn and it costs a lot of tokens.
 *
 * Sections retained, with rationale:
 *  1. Core Mechanics    — d20, DCs, advantage, mods, abilities, skills
 *  3. Combat            — attacks, damage, conditions referenced
 *  4. Conditions        — full list, frequently referenced mid-turn
 *  5. Resting           — short/long rest mechanics
 *  6. Adventuring       — movement, exploration, environment
 *  7. Social Interaction
 *  8. Spellcasting      — components, slots, concentration
 * 18. Important DM-Facing Rules
 * 20. Decision Trees
 */
const COMPACT_RULE_SECTIONS = new Set([1, 3, 4, 5, 6, 7, 8, 18, 20]);

function isInCompactRuleSection(sectionPath: string): boolean {
  const m = /^(\d+)/.exec(sectionPath);
  if (!m) return false;
  return COMPACT_RULE_SECTIONS.has(Number.parseInt(m[1]!, 10));
}

/** Build the cached SRD reference text injected into the master system prompt.
 *  Cached in module memory; cleared by tests via clearSrdContextCache().
 *
 *  Pass `{ compact: true }` to build the lite variant used when
 *  `compactPrompt` is on. Drops sections rarely needed mid-turn
 *  (character creation, equipment subtypes, magic-item overview, class
 *  summary tables), drops the classes/races/backgrounds rosters (the
 *  master can read the character sheet for that), keeps the full
 *  conditions list and the core combat/social/spellcasting rules. */
export async function buildSrdContext(opts?: { compact?: boolean }): Promise<string> {
  const compact = opts?.compact === true;
  if (compact) {
    if (_compactCache) return _compactCache;
  } else {
    if (_cache) return _cache;
  }
  const [rules, classes, races, backgrounds, conditions] = await Promise.all([
    db.select().from(srdRuleDoc).orderBy(asc(srdRuleDoc.sectionPath)),
    db.select().from(srdClass).orderBy(asc(srdClass.name)),
    db.select().from(srdRace).orderBy(asc(srdRace.name)),
    db.select().from(srdBackground).orderBy(asc(srdBackground.name)),
    db.select().from(srdCondition).orderBy(asc(srdCondition.name)),
  ]);

  const sections: string[] = [];

  const filteredRules = compact
    ? rules.filter((r) => isInCompactRuleSection(r.sectionPath))
    : rules;
  sections.push('# Rules reference\n\n' + filteredRules.map((r) => `## ${r.sectionPath}\n${r.markdown}`).join('\n\n'));

  // Classes / Races / Backgrounds: full build emits a roster so the master
  // can recognize what the player picked. In compact mode the master reads
  // the character sheet (which carries the same info), so the roster is
  // dead weight — drop it.
  if (!compact) {
    sections.push('# Classes\n\n' + classes.map((c) => `- **${c.name}** (${c.hitDie}, saves: ${c.savingThrows.join('/')})`).join('\n'));
    sections.push('# Races\n\n' + races.map((r) => `- **${r.name}**${r.parentRaceSlug ? ' (subrace)' : ''}`).join('\n'));
    sections.push('# Backgrounds\n\n' + backgrounds.map((b) => `- **${b.name}** — skills: ${b.skillProficiencies.join(', ')}`).join('\n'));
  }

  // Conditions stay in both builds — the master applies/removes them every
  // turn and needs the canonical effect text.
  sections.push('# Conditions\n\n' + conditions.map((c) => `- **${c.name}**: ${c.description}`).join('\n'));

  const out = sections.join('\n\n---\n\n');
  if (compact) {
    _compactCache = out;
  } else {
    _cache = out;
  }
  return out;
}

export function clearSrdContextCache(): void {
  _cache = null;
  _compactCache = null;
}
