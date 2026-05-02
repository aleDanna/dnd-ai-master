import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import { parseCostToCp } from '@/srd/util/cost';
import type { SrdGearInsert } from '@/db/schema';

type Row = {
  name: string;
  category: string;
  cost: string;
  weight_lb: string;
  description: string;
  source: string;
};

export function parseGear(csv: string): SrdGearInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdGearInsert => ({
    slug: slugify(r.name),
    name: r.name,
    category: r.category,
    costCp: parseCostToCp(r.cost),
    weightLb: parseInt(r.weight_lb, 10) || 0,
    description: r.description,
    source: r.source,
  }));
}
