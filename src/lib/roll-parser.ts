/**
 * Lightweight client-side parser for roll requests in master narration.
 * When manualRolls is ON, the master writes prose like "Roll 1d20+5" or
 * "Roll a DC 14 Dexterity save" instead of calling the rolling tools.
 * The UI parses each master message and offers a roll button per match.
 *
 * Best-effort grammar — covers the patterns the master is instructed to use
 * but won't catch every creative phrasing. Add patterns as needed.
 */

export type RollKind = 'attack' | 'damage' | 'check' | 'save' | 'init' | 'generic';

export interface RollRequest {
  /** A parseable formula like "1d20+5" or "2d6+3". */
  formula: string;
  /** Short label shown on the button — e.g. "Attack 1d20+5" or "DEX save (DC 14)". */
  label: string;
  kind: RollKind;
  /** Index inside the source text — used as a stable React key alongside messageId. */
  index: number;
}

/** Parse a free-form master text for explicit roll requests. */
export function parseRollRequests(text: string): RollRequest[] {
  const requests: RollRequest[] = [];
  const seen = new Set<string>();

  // 1. Bare formula: "Roll 1d20+5"  /  "Roll 2d6 + 3"  / "Roll 1d8"
  const bareRe = /(?:^|[\s(.,!])(?:roll|tira|lancia)\s+((?:\d+)?d\d+\s*(?:[+-]\s*\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(text)) !== null) {
    const raw = m[1]!.replace(/\s+/g, '');
    const formula = normalizeFormula(raw);
    if (!formula) continue;
    const key = `${m.index}:${formula}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: formula,
      kind: inferKind(text, m.index),
      index: m.index,
    });
  }

  // 2. Saves: "Roll a DC 14 Dexterity save"
  const saveRe =
    /(?:roll|make)\s+a?\s*DC\s*(\d+)\s+(STR|DEX|CON|INT|WIS|CHA|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+save/gi;
  while ((m = saveRe.exec(text)) !== null) {
    const dc = parseInt(m[1]!, 10);
    const ability = abbrAbility(m[2]!);
    const formula = '1d20';
    const key = `${m.index}:save:${ability}:${dc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: `${ability} save (DC ${dc})`,
      kind: 'save',
      index: m.index,
    });
  }

  // 3. Skill / ability check: "Roll a DC 14 Perception check" / "Roll a Perception check"
  const checkRe =
    /(?:roll|make)\s+a?\s*(?:DC\s*(\d+)\s+)?(Acrobatics|Animal Handling|Arcana|Athletics|Deception|History|Insight|Intimidation|Investigation|Medicine|Nature|Perception|Performance|Persuasion|Religion|Sleight of Hand|Stealth|Survival|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+check/gi;
  while ((m = checkRe.exec(text)) !== null) {
    const dc = m[1] ? parseInt(m[1], 10) : null;
    const skill = m[2]!;
    const formula = '1d20';
    const key = `${m.index}:check:${skill}:${dc ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: dc !== null ? `${skill} check (DC ${dc})` : `${skill} check`,
      kind: 'check',
      index: m.index,
    });
  }

  return requests.sort((a, b) => a.index - b.index);
}

/** Normalize a formula like "d20" → "1d20" and clamp valid die sizes. */
export function normalizeFormula(raw: string): string | null {
  const m = /^(\d+)?d(\d+)([+-]\d+)?$/i.exec(raw);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2]!, 10);
  if (count < 1 || count > 100) return null;
  if (![4, 6, 8, 10, 12, 20, 100].includes(sides)) return null;
  const modifier = m[3] ?? '';
  return `${count}d${sides}${modifier}`;
}

export interface RollResult {
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
}

export function rollFormula(formula: string, rng: () => number = Math.random): RollResult {
  const m = /^(\d+)?d(\d+)([+-]\d+)?$/i.exec(formula);
  if (!m) throw new Error(`bad formula: ${formula}`);
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2]!, 10);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(rng() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { formula, rolls, modifier, total };
}

function abbrAbility(raw: string): string {
  const k = raw.slice(0, 3).toUpperCase();
  if (['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].includes(k)) return k;
  return raw;
}

function inferKind(text: string, idx: number): RollKind {
  // Tight window: only the descriptor right around the formula. A wider window
  // could leak from one sentence to the next ("attack. ... damage." → false hit).
  const window = text.slice(Math.max(0, idx - 15), idx + 40).toLowerCase();
  // Damage first because "for damage" and "to attack" can both appear in a
  // single chained sentence; the descriptor closest to the formula wins.
  if (/damage|danno|impatt/.test(window)) return 'damage';
  if (/attack|hit/.test(window)) return 'attack';
  if (/save|salvezza/.test(window)) return 'save';
  if (/check|prova/.test(window)) return 'check';
  if (/initiative|iniziativa/.test(window)) return 'init';
  return 'generic';
}
