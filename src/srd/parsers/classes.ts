import { parse } from 'csv-parse/sync';
import { slugify } from '@/srd/util/slug';
import type { SrdClassInsert } from '@/db/schema';

type Row = {
  name: string;
  hit_die: string;
  primary_ability: string;
  saving_throws: string;
  armor_proficiencies: string;
  weapon_proficiencies: string;
  tool_proficiencies: string;
  skill_choices: string;
  spellcasting_ability: string;
  spellcasting_type: string;
  subclass_name: string;
  subclass_choice_level: string;
  subclasses: string;
  key_class_features: string;
  starting_equipment_summary: string;
  source: string;
};

const ABILITY_TO_CODE: Record<string, string> = {
  Strength: 'STR', Dexterity: 'DEX', Constitution: 'CON',
  Intelligence: 'INT', Wisdom: 'WIS', Charisma: 'CHA',
};

function splitList(s: string): string[] {
  return s
    .split(/[;,]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseSavingThrows(s: string): string[] {
  return splitList(s).map((tok) => ABILITY_TO_CODE[tok] ?? tok.toUpperCase().slice(0, 3));
}

function parseSpellcasting(ability: string, type: string): SrdClassInsert['spellcasting'] {
  if (!ability || ability === 'None' || !type || type === 'None') return null;
  const t = type as 'Full' | 'Half' | 'Third' | 'Pact';
  return { ability, type: t };
}

function parseSubclasses(s: string): { name: string; source: string }[] {
  if (!s.trim()) return [];
  return s.split(/,\s*/).map((tok) => {
    const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(tok.trim());
    if (m) return { name: m[1]!.trim(), source: m[2]!.trim() };
    return { name: tok.trim(), source: 'PHB' };
  });
}

function parseKeyFeatures(s: string): { level: number; features: string[] }[] {
  if (!s.trim()) return [];
  return s.split(/;\s*/).flatMap((segment) => {
    const m = /^(\d+):\s*(.+)$/.exec(segment.trim());
    if (!m) return [];
    return [{ level: Number(m[1]), features: splitList(m[2]!) }];
  });
}

function parseSkillChoices(s: string): { count: number; from: string[] } {
  const m = /^(\d+)\s*from\s*(.+)$/i.exec(s);
  if (!m) return { count: 0, from: [] };
  const count = Number(m[1]);
  const fromRaw = m[2]!.trim();
  if (fromRaw.toLowerCase() === 'any') return { count, from: ['*'] };
  return { count, from: splitList(fromRaw) };
}

export function parseClasses(csv: string): SrdClassInsert[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
  return rows.map((r): SrdClassInsert => {
    const skill = parseSkillChoices(r.skill_choices);
    return {
      slug: slugify(r.name),
      name: r.name,
      hitDie: r.hit_die,
      primaryAbility: splitList(r.primary_ability),
      savingThrows: parseSavingThrows(r.saving_throws),
      proficiencies: {
        armor: splitList(r.armor_proficiencies),
        weapons: splitList(r.weapon_proficiencies),
        tools: r.tool_proficiencies === 'None' ? [] : splitList(r.tool_proficiencies),
        skillsChoose: skill.count,
        skillsFrom: skill.from,
      },
      spellcasting: parseSpellcasting(r.spellcasting_ability, r.spellcasting_type),
      subclassName: r.subclass_name || null,
      subclassChoiceLevel: r.subclass_choice_level ? Number(r.subclass_choice_level) : null,
      subclasses: parseSubclasses(r.subclasses),
      keyFeatures: parseKeyFeatures(r.key_class_features),
      startingEquipmentSummary: r.starting_equipment_summary,
      source: r.source,
    };
  });
}
