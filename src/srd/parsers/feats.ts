import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdFeatInsert } from '@/db/schema';

type Row = {
  name: string;
  prerequisites: string;
  benefits: string;
  source: string;
};

export function parseFeats(csv: string): SrdFeatInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdFeatInsert => ({
    slug: slugify(r.name),
    name: r.name,
    prerequisites: r.prerequisites,
    benefits: r.benefits,
    source: r.source,
  }));
}
