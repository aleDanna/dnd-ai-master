import { db } from '@/db/client';
import { srdRuleDoc, srdClass, srdRace, srdBackground, srdCondition } from '@/db/schema';
import { asc } from 'drizzle-orm';

let _cache: string | null = null;

/** Build the cached SRD reference text injected into the master system prompt.
 *  Cached in module memory; cleared by tests via clearSrdContextCache(). */
export async function buildSrdContext(): Promise<string> {
  if (_cache) return _cache;
  const [rules, classes, races, backgrounds, conditions] = await Promise.all([
    db.select().from(srdRuleDoc).orderBy(asc(srdRuleDoc.sectionPath)),
    db.select().from(srdClass).orderBy(asc(srdClass.name)),
    db.select().from(srdRace).orderBy(asc(srdRace.name)),
    db.select().from(srdBackground).orderBy(asc(srdBackground.name)),
    db.select().from(srdCondition).orderBy(asc(srdCondition.name)),
  ]);

  const sections: string[] = [];

  sections.push('# Rules reference\n\n' + rules.map((r) => `## ${r.sectionPath}\n${r.markdown}`).join('\n\n'));

  sections.push('# Classes\n\n' + classes.map((c) => `- **${c.name}** (${c.hitDie}, saves: ${c.savingThrows.join('/')})`).join('\n'));

  sections.push('# Races\n\n' + races.map((r) => `- **${r.name}**${r.parentRaceSlug ? ' (subrace)' : ''}`).join('\n'));

  sections.push('# Backgrounds\n\n' + backgrounds.map((b) => `- **${b.name}** — skills: ${b.skillProficiencies.join(', ')}`).join('\n'));

  sections.push('# Conditions\n\n' + conditions.map((c) => `- **${c.name}**: ${c.description}`).join('\n'));

  _cache = sections.join('\n\n---\n\n');
  return _cache;
}

export function clearSrdContextCache(): void {
  _cache = null;
}
