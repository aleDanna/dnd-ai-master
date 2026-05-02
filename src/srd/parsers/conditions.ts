import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdConditionInsert } from '@/db/schema';

type Row = {
  name: string;
  description: string;
  effects: string;
  source: string;
};

export function parseConditions(csv: string): SrdConditionInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdConditionInsert => ({
    slug: slugify(r.name),
    name: r.name,
    description: r.description,
    effects: r.effects,
    source: r.source,
  }));
}
