/**
 * Plan D — baked Ollama master models.
 *
 * A "baked" model is a customised variant of a local base model (qwen3,
 * gpt-oss, ...) created via `ollama create dnd-master-<base> -f Modelfile`
 * where the Modelfile's `SYSTEM` directive carries the full static
 * portion of the master system prompt (BASE + TOOL_CONTRACT +
 * META_TOOLS + ROLL_TRIGGERS + REWARDS_MANDATE + handbook + world lore +
 * memory rule + SRD context). At runtime the turn route detects the
 * `dnd-master-` prefix and omits those static blocks from the request,
 * shrinking the per-turn prompt from ~120 KB to ~10 KB.
 *
 * See docs/superpowers/specs/2026-05-16-local-baked-models-design.md.
 */

export const BAKED_PREFIX = 'dnd-master-';

/** True iff `slug` names a baked variant (built by `pnpm build-local-models`). */
export function isBakedModel(slug: string): boolean {
  return slug.startsWith(BAKED_PREFIX);
}

/**
 * Recover the original Ollama base model slug from a baked-variant name.
 *
 * Convention: when building, `ollama create` requires `[a-z0-9_.-]` for
 * model names — `:` is not allowed. The build script normalises by
 * replacing the FIRST `:` in the base slug with `-` (the boundary
 * between the name and the tag), leaving any later `-` in the tag (e.g.
 * `qwen3:30b-a3b` → `qwen3-30b-a3b`) untouched.
 *
 * To reverse: strip the prefix, then turn the FIRST `-` back into `:`.
 *
 * Examples:
 *  - 'dnd-master-qwen3-30b'      → 'qwen3:30b'
 *  - 'dnd-master-qwen3-30b-a3b'  → 'qwen3:30b-a3b'
 *  - 'dnd-master-qwen3-14b'      → 'qwen3:14b'
 *  - 'dnd-master-gpt-oss-20b'    → 'gpt-oss:20b'   (NOT 'gpt:oss-20b')
 *
 * The "gpt-oss" case is the one to watch: the base name itself contains
 * a `-`, so we MUST only replace the first `-` after the prefix. The
 * build script encodes the inverse rule so both sides stay in sync.
 *
 * Returns null when `slug` doesn't start with the baked prefix or has
 * no separator after it (malformed).
 */
export function getBakedBaseModel(slug: string): string | null {
  if (!isBakedModel(slug)) return null;
  const rest = slug.slice(BAKED_PREFIX.length);
  const dashIdx = rest.indexOf('-');
  if (dashIdx < 0) return null;
  return rest.slice(0, dashIdx) + ':' + rest.slice(dashIdx + 1);
}

/**
 * Inverse: produce the baked-variant name for a given base model slug.
 * Replaces only the FIRST `:` with `-` (see getBakedBaseModel for why).
 *
 * Examples:
 *  - 'qwen3:30b'      → 'dnd-master-qwen3-30b'
 *  - 'qwen3:30b-a3b'  → 'dnd-master-qwen3-30b-a3b'
 *  - 'gpt-oss:20b'    → 'dnd-master-gpt-oss-20b'
 *
 * Returns null for slugs without a `:` (we expect Ollama base slugs to
 * always have a tag like `:30b` or `:latest`).
 */
export function getBakedModelName(baseSlug: string): string | null {
  const colonIdx = baseSlug.indexOf(':');
  if (colonIdx < 0) return null;
  return BAKED_PREFIX + baseSlug.slice(0, colonIdx) + '-' + baseSlug.slice(colonIdx + 1);
}
