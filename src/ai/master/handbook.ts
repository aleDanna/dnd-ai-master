import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _cache: string | null = null;

/**
 * The DM Craft Handbook (curated from the 5e DMG 2024).
 *
 * Loaded once from `data/master_handbook.md` and cached in module memory for
 * the lifetime of the server process. Wired into the master system prompt as
 * a dedicated cached block so the model gets craft-level guidance (pacing,
 * narration, when to call rolls, NPC voicing, etc.) on top of the
 * mechanical SRD reference.
 *
 * The file lives next to the existing `data/rules.md` and follows the same
 * markdown structure (numbered sections), so future tooling can index it if
 * we ever want section-level lookup. For now we just inject the whole thing.
 */
export function getMasterHandbook(): string {
  if (_cache) return _cache;
  const path = join(process.cwd(), 'data', 'master_handbook.md');
  _cache = readFileSync(path, 'utf8');
  return _cache;
}

/** Test seam — call between tests that mutate the file or want to force a reload. */
export function clearMasterHandbookCache(): void {
  _cache = null;
}
