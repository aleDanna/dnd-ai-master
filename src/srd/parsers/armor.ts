import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import { parseCostToCp } from '@/srd/util/cost';
import type { SrdArmorInsert } from '@/db/schema';

type Row = {
  name: string;
  category: string;
  armor_class: string;
  strength_required: string;
  stealth: string;
  cost: string;
  weight_lb: string;
  don_time: string;
  doff_time: string;
  source: string;
};

function parseStrengthRequired(raw: string): number | null {
  const t = raw?.trim() ?? '';
  if (t === '' || t === '—' || t === '-') return null;
  // Accept formats like "STR 13", "Str 15", or a bare integer.
  const m = /(\d+)/.exec(t);
  return m ? parseInt(m[1]!, 10) : null;
}

export function parseArmor(csv: string): SrdArmorInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdArmorInsert => ({
    slug: slugify(r.name),
    name: r.name,
    category: r.category,
    acFormula: r.armor_class,
    strengthRequired: parseStrengthRequired(r.strength_required),
    stealthDisadvantage: /disadvantage/i.test(r.stealth),
    costCp: parseCostToCp(r.cost),
    weightLb: parseInt(r.weight_lb, 10) || 0,
    donTime: r.don_time,
    doffTime: r.doff_time,
    source: r.source,
  }));
}
