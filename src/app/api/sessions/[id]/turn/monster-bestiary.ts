/**
 * D-04 / D-07 — Isolated SRD bestiary attack-prose parser.
 *
 * Given a monster name, slug-normalize it, read
 * `data/vault/handbook/monsters/<slug>.md` through the existing path-safe
 * `readVaultFile` (which routes through `safeVaultPath`), and extract the first
 * attack line's `{attackBonus, damageDice}` from the `## Actions` prose.
 *
 * This module is DELIBERATELY ISOLATED (D-07): it is a colocated pure-function
 * helper (no `next/*` imports, not a route handler) with NO dependency on the
 * 09-01/09-02 event/loop work, so it cannot block the smoke-critical custom-
 * monster (CR-table) path. The 09-04 loop calls it FIRST in its 3-level
 * fallback; a `null` return cleanly cedes to the D-05 CR table / D-06 default.
 *
 * Safety invariants:
 *  - Path: every name is slug-normalized and routed through `readVaultFile` →
 *    `safeVaultPath` (traversal/symlink/null-byte guarded). No hand-rolled
 *    fs/path joining (T-09-08).
 *  - ReDoS: the attack/dice regexes run PER-BLOCK-DESCRIPTION (bounded), never
 *    as a single greedy pass over the whole multi-line body (T-09-09).
 *  - Never throws: any miss (no file, unsafe path, unparseable prose, empty
 *    slug) returns `null` so the caller falls back to the named-constant
 *    D-05/D-06 path (T-09-10).
 */
import { readVaultFile } from '@/ai/master/vault/path';
import { slugify } from '@/srd/util/slug';

export interface BestiaryAttackStats {
  attackBonus: number;
  damageDice: string;
}

// `+N to hit` is the reliable signal that a block is an attack action.
// Bounded: a literal `+`, then digits, then `to hit` with limited whitespace.
const ATTACK_HIT_RE = /\+(\d+)\s{0,4}to\s{1,4}hit/i;

// Captures the first `XdY` or `XdY+Z` / `XdY-Z`. The compound rider on
// dragon-style lines (`... + 4d6 fire`) is intentionally ignored for v2 — the
// first match is the primary die.
const DAMAGE_DICE_RE = /(\d+d\d+(?:[+-]\d+)?)/;

/**
 * Split a `## Actions` prose body into per-block `{name, description}` segments.
 *
 * Minimal local re-implementation of the colon/parenthetical split used by
 * `parseNamedBlocks` in `src/srd/parsers/monsters.ts` (which is module-private
 * and intentionally NOT modified here, preserving this module's isolation).
 * Only the colon form is load-bearing for attack extraction; the parenthetical
 * and bare-fallback forms are kept so non-attack blocks (e.g. "Nimble Escape
 * (...)", "Multiattack: ...") segment cleanly and are then skipped by the
 * `+N to hit` filter.
 *
 * Bounded by construction: the split is a single linear scan with a
 * lookahead on a bounded character class — no nested quantifiers.
 */
function splitActionBlocks(raw: string): { name: string; description: string }[] {
  if (!raw.trim()) return [];
  // Split on a sentence-ending `.` that is immediately followed by a new
  // "Name:" or "Name (" block header. Mirrors parseNamedBlocks's splitter.
  const segments = raw.split(/\.(?=\s*[A-Z][^.]+(?::|\s*\())/);
  const blocks: { name: string; description: string }[] = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    // Colon form: "Scimitar: +4 to hit, ...".
    const colon = /^([^:]+):\s*(.+?)\.?\s*$/s.exec(trimmed);
    if (colon) {
      blocks.push({ name: colon[1]!.trim(), description: colon[2]!.trim() });
      continue;
    }
    // Parenthetical form: "Nimble Escape (Disengage ...)".
    const paren = /^([^()]+?)\s*\(([^()]+)\)\s*\.?\s*$/s.exec(trimmed);
    if (paren) {
      blocks.push({ name: paren[1]!.trim(), description: paren[2]!.trim() });
      continue;
    }
    // Fallback: keep the raw text as the description (still subject to the
    // `+N to hit` filter, so non-attack prose is harmlessly skipped).
    blocks.push({ name: '', description: trimmed });
  }
  return blocks.filter((b) => b.name.length > 0 || b.description.length > 0);
}

/**
 * Parse the FIRST attack from a `## Actions` prose body.
 *
 * Iterates blocks; for the first block whose description has a `+N to hit`,
 * reads `attackBonus` and extracts `damageDice` (NdM / NdM±K) from that SAME
 * block. Blocks with a hit but no dice are skipped (continue). Returns `null`
 * if no block yields both — e.g. a leading `Multiattack` line (no `+N to hit`)
 * is skipped, and a pure-trait body yields `null`.
 *
 * ReDoS-safe: both regexes run on a single block description at a time
 * (bounded input), never over the full multi-line body with greedy
 * alternation.
 */
export function parseFirstAttackFromProse(actionsText: string): BestiaryAttackStats | null {
  if (typeof actionsText !== 'string' || !actionsText.trim()) return null;
  const blocks = splitActionBlocks(actionsText);
  for (const block of blocks) {
    const hitMatch = ATTACK_HIT_RE.exec(block.description);
    if (!hitMatch) continue; // Multiattack, Breath, traits — no `+N to hit`.
    const attackBonus = parseInt(hitMatch[1]!, 10);
    const diceMatch = DAMAGE_DICE_RE.exec(block.description);
    if (!diceMatch) continue; // Has a hit but no usable dice — keep looking.
    return { attackBonus, damageDice: diceMatch[1]! };
  }
  return null;
}

/**
 * Extract the body of the `## Actions` section from a bestiary markdown file.
 * Returns the text between the `## Actions` heading and the next `## ` heading
 * (or end of file), or `null` if there is no `## Actions` section.
 *
 * Bounded: per-line scan, no backtracking-prone patterns.
 */
function extractActionsSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let inActions = false;
  const body: string[] = [];
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (inActions) break; // reached the next section heading
      if (heading[1]!.toLowerCase() === 'actions') {
        inActions = true;
      }
      continue;
    }
    if (inActions) body.push(line);
  }
  if (!inActions) return null;
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

/**
 * Look up a monster's first-attack profile from the SRD bestiary by name.
 *
 * Slug-normalizes `name` (reusing `slugify`, so lookup slugs match the
 * on-disk filenames written by seed-bestiary.ts), reads
 * `handbook/monsters/<slug>.md` via the path-safe `readVaultFile`, and parses
 * its `## Actions` prose. Returns `null` on ANY miss — empty/invalid name,
 * file not found, unsafe path (readVaultFile returns an `ERROR` marker), no
 * `## Actions` section, or no parseable attack line — so the 09-04 loop
 * absorbs the failure as "use the CR/default fallback". NEVER throws.
 */
export async function getBestiaryAttackStats(name: string): Promise<BestiaryAttackStats | null> {
  if (typeof name !== 'string' || !name.trim()) return null;
  let slug: string;
  try {
    // slugify throws when the input produces an empty slug (e.g. "!!!"); a
    // traversal name like "../../../etc/passwd" slugifies to a harmless
    // "etc-passwd", which readVaultFile then confines to the bestiary dir.
    slug = slugify(name);
  } catch {
    return null;
  }
  const contents = await readVaultFile(`handbook/monsters/${slug}.md`);
  // readVaultFile never throws — it returns file contents OR an `ERROR: ...`
  // marker (file not found / path outside vault / unreadable).
  if (contents.startsWith('ERROR')) return null;
  const actions = extractActionsSection(contents);
  if (actions === null) return null;
  return parseFirstAttackFromProse(actions);
}
