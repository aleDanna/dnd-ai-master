import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdBackgroundInsert } from '@/db/schema';

type Row = {
  name: string;
  skill_proficiencies: string;
  tool_proficiencies: string;
  languages: string;
  starting_equipment: string;
  feature: string;
  suggested_traits: string;
  source: string;
};

function splitList(s: string): string[] {
  if (!s || s.toLowerCase() === 'none') return [];
  return s.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
}

export function parseBackgrounds(csv: string): SrdBackgroundInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdBackgroundInsert => ({
    slug: slugify(r.name),
    name: r.name,
    skillProficiencies: splitList(r.skill_proficiencies),
    toolProficiencies: splitList(r.tool_proficiencies),
    languages: r.languages,
    startingEquipment: r.starting_equipment,
    feature: r.feature,
    suggestedTraits: r.suggested_traits || null,
    source: r.source,
  }));
}
