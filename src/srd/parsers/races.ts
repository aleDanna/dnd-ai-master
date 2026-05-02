import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdRaceInsert } from '@/db/schema';

type Row = {
  name: string;
  parent_race: string;
  ability_score_increase: string;
  size: string;
  speed: string;
  age_typical_lifespan: string;
  languages: string;
  traits: string;
  subrace_options: string;
  source: string;
};

const ABILITY_TO_CODE: Record<string, string> = {
  STR: 'STR', DEX: 'DEX', CON: 'CON', INT: 'INT', WIS: 'WIS', CHA: 'CHA',
  Strength: 'STR', Dexterity: 'DEX', Constitution: 'CON',
  Intelligence: 'INT', Wisdom: 'WIS', Charisma: 'CHA',
};

function parseAsi(raw: string): Record<string, number | 'choice'> {
  const out: Record<string, number | 'choice'> = {};
  for (const tok of raw.split(/[,;]\s*/)) {
    const t = tok.trim();
    if (!t) continue;
    const choiceMatch = /^choice\s*\+(\d+)/i.exec(t);
    if (choiceMatch) {
      out[`choice+${choiceMatch[1]}`] = 'choice';
      continue;
    }
    const m = /^([A-Za-z]+)\s*\+(\d+)/.exec(t);
    if (m) {
      const code = ABILITY_TO_CODE[m[1]!] ?? m[1]!.toUpperCase();
      out[code] = Number(m[2]);
    }
  }
  return out;
}

function parseTraits(raw: string): { name: string; description: string }[] {
  if (!raw.trim()) return [];
  return raw.split(/;\s*/).map((seg) => {
    const m = /^([^(]+?)\s*\(([^)]+)\)\s*$/.exec(seg.trim());
    if (m) return { name: m[1]!.trim(), description: m[2]!.trim() };
    return { name: seg.trim(), description: '' };
  });
}

function parseSubraces(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
}

export function parseRaces(csv: string): SrdRaceInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdRaceInsert => ({
    slug: slugify(r.name),
    name: r.name,
    parentRaceSlug: r.parent_race ? slugify(r.parent_race) : null,
    abilityScoreIncrease: parseAsi(r.ability_score_increase),
    size: r.size,
    speed: parseInt(r.speed, 10) || 30,
    ageNote: r.age_typical_lifespan || null,
    languages: r.languages.split(/,\s*/).map((s) => s.trim()).filter(Boolean),
    traits: parseTraits(r.traits),
    subraceOptions: parseSubraces(r.subrace_options),
    source: r.source,
  }));
}
