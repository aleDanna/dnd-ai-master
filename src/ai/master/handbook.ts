import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _craftCache: string | null = null;
let _worldCache: string | null = null;
let _craftCompactCache: string | null = null;
let _worldCompactCache: string | null = null;

/**
 * The DM Craft Handbook (curated from the 5e DMG 2024, chapters 1-3).
 *
 * Covers HOW to run sessions: pacing, narration, when to call rolls, NPC
 * voicing, common pitfalls. Loaded once from `data/master_handbook.md` and
 * cached in module memory for the lifetime of the server process.
 *
 * Pass `{ compact: true }` to load the lite variant
 * (`data/master_handbook_compact.md`) used when `compactPrompt` is on —
 * about 1/3 the size, imperative-only, drops prose/rationale. Trades
 * narrative depth for fitting comfortably in a small local model's
 * context window without losing the rules.
 */
export function getMasterHandbook(opts?: { compact?: boolean }): string {
  if (opts?.compact) {
    if (_craftCompactCache) return _craftCompactCache;
    const path = join(process.cwd(), 'data', 'master_handbook_compact.md');
    _craftCompactCache = readFileSync(path, 'utf8');
    return _craftCompactCache;
  }
  if (_craftCache) return _craftCache;
  const path = join(process.cwd(), 'data', 'master_handbook.md');
  _craftCache = readFileSync(path, 'utf8');
  return _craftCache;
}

/**
 * The DM World & Lore Handbook (curated from the 5e DMG 2024, chapters
 * 4-7 + Lore Glossary).
 *
 * Covers WHAT the world contains: cosmology (Great Wheel, planes, Sigil),
 * magic (sources, schools, items, attunement), deities and religion,
 * cultures and factions, settlement archetypes, campaign frames, REWARDS
 * AND GRATIFICATION (mandatory loot at end of every dungeon), and how to
 * answer the player's worldbuilding questions on the fly.
 *
 * Pass `{ compact: true }` to load the lite variant
 * (`data/master_world_lore_compact.md`), used when `compactPrompt` is on.
 * Keeps the critical Rewards mandate and stripped cosmology/magic
 * references; drops most narrative flavor.
 */
export function getMasterWorldLore(opts?: { compact?: boolean }): string {
  if (opts?.compact) {
    if (_worldCompactCache) return _worldCompactCache;
    const path = join(process.cwd(), 'data', 'master_world_lore_compact.md');
    _worldCompactCache = readFileSync(path, 'utf8');
    return _worldCompactCache;
  }
  if (_worldCache) return _worldCache;
  const path = join(process.cwd(), 'data', 'master_world_lore.md');
  _worldCache = readFileSync(path, 'utf8');
  return _worldCache;
}

/** Test seam — call between tests that mutate the files or want to force a reload. */
export function clearMasterHandbookCache(): void {
  _craftCache = null;
  _worldCache = null;
  _craftCompactCache = null;
  _worldCompactCache = null;
}
