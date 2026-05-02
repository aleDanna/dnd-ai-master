import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import { parseCostToCp } from '@/srd/util/cost';
import type { SrdWeaponInsert } from '@/db/schema';

type Row = {
  name: string;
  category: string;
  proficiency_group: string;
  damage: string;
  damage_type: string;
  properties: string;
  cost: string;
  weight_lb: string;
  range: string;
  source: string;
};

export function parseWeapons(csv: string): SrdWeaponInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdWeaponInsert => ({
    slug: slugify(r.name),
    name: r.name,
    category: r.category,
    proficiencyGroup: r.proficiency_group,
    damage: r.damage,
    damageType: r.damage_type,
    properties: r.properties ? r.properties.split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [],
    costCp: parseCostToCp(r.cost),
    weightLb: parseInt(r.weight_lb, 10) || 0,
    range: r.range || null,
    source: r.source,
  }));
}
