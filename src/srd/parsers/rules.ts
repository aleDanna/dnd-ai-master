import { slugify } from '@/srd/util/slug';
import type { SrdRuleDocInsert } from '@/db/schema';

const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/gm;

export function parseRules(md: string): SrdRuleDocInsert[] {
  type Match = { level: number; title: string; start: number; end: number };
  const matches: Match[] = [];
  for (const m of md.matchAll(HEADING_RE)) {
    matches.push({
      level: m[1]!.length,
      title: m[2]!.trim(),
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }

  const sections: SrdRuleDocInsert[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    // Only sections with a numeric prefix like "1.3 Advantage and Disadvantage" become rule docs.
    if (!/^\d+(\.\d+)*\s+/.test(cur.title)) continue;
    const next = matches[i + 1];
    const bodyStart = cur.end + 1;
    const bodyEnd = next ? next.start : md.length;
    const body = md.slice(bodyStart, bodyEnd).trim();
    sections.push({
      sectionPath: cur.title,
      anchor: slugify(cur.title),
      markdown: body,
    });
  }
  return sections;
}
