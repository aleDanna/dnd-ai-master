/**
 * seed-bestiary.ts
 *
 * Reads data/monsters.csv (180 SRD monsters) and writes one markdown file per
 * row to data/vault/handbook/monsters/<slug>.md. The generated files are
 * committed to the repo as static vault knowledge for the AI master.
 *
 * Usage:
 *   pnpm tsx scripts/seed-bestiary.ts
 *
 * No database access, no environment variables required. Pure filesystem I/O.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname ?? __dirname, '..');
const CSV_PATH = join(PROJECT_ROOT, 'data', 'monsters.csv');
const OUT_DIR = join(PROJECT_ROOT, 'data', 'vault', 'handbook', 'monsters');

// ---------------------------------------------------------------------------
// Minimal quoted-CSV parser.
// Handles double-quoted fields (including embedded commas and newlines via
// the RFC 4180 "" escape for literal quotes). Sufficient for the SRD CSV.
// ---------------------------------------------------------------------------

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i <= line.length) {
    if (i === line.length) {
      // Trailing empty field or end of input.
      fields.push('');
      break;
    }

    if (line[i] === '"') {
      // Quoted field — collect until closing unescaped quote.
      i++; // skip opening quote
      let field = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            // Escaped quote.
            field += '"';
            i += 2;
          } else {
            // Closing quote.
            i++;
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      // Skip the comma after the closing quote (if present).
      if (line[i] === ',') i++;
    } else {
      // Unquoted field — collect until comma or end.
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      fields.push(line.slice(start, i));
      if (line[i] === ',') i++;
    }
  }

  return fields;
}

function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  // Split on newlines; the SRD CSV does not have multi-line fields so this is safe.
  const lines = content.trim().split('\n');
  const headers = parseCSVLine(lines[0]!);

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] ?? '';
    }
    rows.push(row);
  }

  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Slug derivation: lowercase, non-alphanumeric runs → single hyphen, trim.
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Frontmatter + body builder.
// ---------------------------------------------------------------------------

function buildMonsterDoc(row: Record<string, string>): string {
  const name = row['name'] ?? '';
  const hpMax = parseInt(row['hit_points'] ?? '0', 10) || 0;
  const ac = parseInt(row['armor_class'] ?? '0', 10) || 0;
  const dex = parseInt(row['dex'] ?? '10', 10) || 10;
  const initiativeBonus = Math.floor((dex - 10) / 2);
  const cr = row['challenge_rating'] ?? '';
  const xp = row['xp'] ?? '';
  const traits = (row['traits'] ?? '').trim();
  const actions = (row['actions'] ?? '').trim();

  const lines: string[] = [
    '---',
    `name: ${name}`,
    `hpMax: ${hpMax}`,
    `ac: ${ac}`,
    `initiativeBonus: ${initiativeBonus}`,
    `cr: "${cr}"`,
    `xp: ${xp}`,
    '---',
    '',
  ];

  if (actions) {
    lines.push('## Actions', '', actions, '');
  }

  if (traits) {
    lines.push('## Traits', '', traits, '');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const csv = readFileSync(CSV_PATH, 'utf8');
  const { rows } = parseCSV(csv);

  mkdirSync(OUT_DIR, { recursive: true });

  let count = 0;
  for (const row of rows) {
    const name = row['name'];
    if (!name) continue;

    const slug = slugify(name);
    const content = buildMonsterDoc(row);
    const outPath = join(OUT_DIR, `${slug}.md`);
    writeFileSync(outPath, content, 'utf8');
    count++;
  }

  console.log(`Seeded ${count} monsters to data/vault/handbook/monsters/`);
}

main();
