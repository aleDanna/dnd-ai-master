import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _craftCache: string | null = null;
let _worldCache: string | null = null;

/**
 * The DM Craft Handbook (curated from the 5e DMG 2024, chapters 1-3).
 *
 * Covers HOW to run sessions: pacing, narration, when to call rolls, NPC
 * voicing, common pitfalls. Loaded once from `data/master_handbook.md` and
 * cached in module memory for the lifetime of the server process.
 */
export function getMasterHandbook(): string {
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
 */
export function getMasterWorldLore(): string {
  if (_worldCache) return _worldCache;
  const path = join(process.cwd(), 'data', 'master_world_lore.md');
  _worldCache = readFileSync(path, 'utf8');
  return _worldCache;
}

/** Test seam — call between tests that mutate the files or want to force a reload. */
export function clearMasterHandbookCache(): void {
  _craftCache = null;
  _worldCache = null;
}
