import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdMonsterInsert } from '@/db/schema';

type Row = {
  name: string;
  size: string;
  type: string;
  alignment: string;
  armor_class: string;
  hit_points: string;
  speed: string;
  str: string;
  dex: string;
  con: string;
  int: string;
  wis: string;
  cha: string;
  saving_throws: string;
  skills: string;
  damage_resistances: string;
  damage_immunities: string;
  condition_immunities: string;
  senses: string;
  languages: string;
  challenge_rating: string;
  xp: string;
  traits: string;
  actions: string;
  source: string;
};

function parseAcAndHp(ac: string, hp: string): { ac: number; hp: number; hpFormula: string } {
  const acNum = parseInt(ac, 10);
  const hpMatch = /^(\d+)(?:\s*\(([^)]+)\))?/.exec(hp.trim());
  const hpNum = hpMatch ? parseInt(hpMatch[1]!, 10) : 0;
  const hpFormula = hpMatch?.[2] ?? '';
  return { ac: acNum, hp: hpNum, hpFormula };
}

function parseCr(s: string): string {
  const t = s.trim();
  if (t === '') return '0';
  if (t === '1/8') return '0.125';
  if (t === '1/4') return '0.25';
  if (t === '1/2') return '0.5';
  return t;
}

function parseModifierMap(s: string): Record<string, number> {
  if (!s.trim()) return {};
  const out: Record<string, number> = {};
  for (const seg of s.split(/[,;]\s*/)) {
    const m = /^([A-Za-z ]+?)\s*([+-]?\d+)$/.exec(seg.trim());
    if (m) out[m[1]!.trim()] = parseInt(m[2]!, 10);
  }
  return out;
}

function parseTagList(s: string): string[] {
  if (!s.trim()) return [];
  return s.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean);
}

function parseNamedBlocks(raw: string): { name: string; description: string }[] {
  if (!raw.trim()) return [];
  // Format example: "Multiattack: ... . Fist: +5 to hit, ..."
  const segments = raw.split(/\.(?=\s*[A-Z][^.]+:)/);
  return segments
    .map((seg) => {
      const m = /^([^:]+):\s*(.+)\.?\s*$/s.exec(seg.trim());
      if (m) return { name: m[1]!.trim(), description: m[2]!.trim() };
      return { name: '', description: seg.trim() };
    })
    .filter((b) => b.description.length > 0);
}

export function parseMonsters(csv: string): SrdMonsterInsert[] {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  }) as Row[];
  return rows.map((r): SrdMonsterInsert => {
    const { ac, hp, hpFormula } = parseAcAndHp(r.armor_class, r.hit_points);
    return {
      slug: slugify(r.name),
      name: r.name,
      size: r.size,
      type: r.type,
      alignment: r.alignment,
      ac,
      hp,
      hpFormula,
      speed: r.speed,
      str: parseInt(r.str, 10),
      dex: parseInt(r.dex, 10),
      con: parseInt(r.con, 10),
      int: parseInt(r.int, 10),
      wis: parseInt(r.wis, 10),
      cha: parseInt(r.cha, 10),
      savingThrows: parseModifierMap(r.saving_throws),
      skills: parseModifierMap(r.skills),
      damageResistances: parseTagList(r.damage_resistances),
      damageImmunities: parseTagList(r.damage_immunities),
      conditionImmunities: parseTagList(r.condition_immunities),
      senses: r.senses,
      languages: r.languages,
      cr: parseCr(r.challenge_rating),
      xp: parseInt(r.xp.replace(/,/g, ''), 10) || 0,
      traits: parseNamedBlocks(r.traits),
      actions: parseNamedBlocks(r.actions),
      source: r.source,
    };
  });
}
