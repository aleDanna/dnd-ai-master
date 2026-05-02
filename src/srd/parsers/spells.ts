import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdSpellInsert } from '@/db/schema';

type Row = {
  name: string;
  level: string;
  school: string;
  casting_time: string;
  range: string;
  components: string;
  duration: string;
  concentration: string;
  ritual: string;
  classes: string;
  description: string;
  source: string;
};

function parseBool(s: string): boolean {
  return /^(yes|true|y|1)$/i.test(s.trim());
}

export function parseSpells(csv: string): SrdSpellInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdSpellInsert => ({
    slug: slugify(r.name),
    name: r.name,
    level: parseInt(r.level, 10),
    school: r.school,
    castingTime: r.casting_time,
    range: r.range,
    components: r.components,
    duration: r.duration,
    concentration: parseBool(r.concentration),
    ritual: parseBool(r.ritual),
    classes: r.classes.split(/,\s*/).map((s) => s.trim()).filter(Boolean),
    description: r.description,
    source: r.source,
  }));
}
