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

/**
 * Compute the 16-hex-character content hash the build script stamps into
 * each Modelfile. The hash covers `v<MASTER_PROMPT_VERSION>\n` + the
 * concatenated static blocks in the runtime emit order. Both build-time
 * and runtime callers must produce the same hash for the staleness
 * check to work — keep this function and `computeContentHash` in the
 * build script in sync.
 */
export async function computeMasterPromptHash(systemContent: string, promptVersion: number): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  h.update(`v${promptVersion}\n`);
  h.update(systemContent);
  return h.digest('hex').slice(0, 16);
}

// ── Runtime staleness check ────────────────────────────────────────────────
//
// When the user selects a `dnd-master-*` model, we want to warn them if
// the baked content drifted from what the runtime would have emitted —
// e.g. handbook.md was edited but the model wasn't rebuilt.
//
// Memoise per (slug, modelHash, runtimeHash) tuple so we log at most one
// warning per process per stale combination. Don't spam on every turn.

const _warnedKeys = new Set<string>();

interface StalenessResult {
  stale: boolean;
  modelHash: string | null;
  runtimeHash: string;
}

/**
 * Read the baked model's Modelfile from Ollama via /api/show and parse
 * the `# Source content hash:` comment. Returns null on any failure
 * (model missing, Ollama unreachable, no hash line found) — callers
 * should treat that as "can't verify; assume fine".
 */
export async function readBakedModelHash(
  modelName: string,
  ollamaBase: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${ollamaBase}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { modelfile?: string };
    if (!data.modelfile) return null;
    const m = /^# Source content hash: ([a-f0-9]+)\s*$/m.exec(data.modelfile);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget staleness check + one-shot warning. Safe to call from
 * the turn route after the response is dispatched (e.g. inside
 * waitUntil). Awaits its own work — never throws.
 *
 *  - runtimeHashPromise: a resolved-once promise carrying the current
 *    runtime's prompt hash. The caller is responsible for memoising it
 *    so we don't recompute on every turn.
 */
export async function warnIfBakedModelStale(args: {
  modelName: string;
  ollamaBase: string;
  runtimeHash: string;
}): Promise<StalenessResult | null> {
  const modelHash = await readBakedModelHash(args.modelName, args.ollamaBase);
  const result: StalenessResult = {
    stale: modelHash !== null && modelHash !== args.runtimeHash,
    modelHash,
    runtimeHash: args.runtimeHash,
  };
  if (!result.stale) return result;

  const key = `${args.modelName}|${modelHash}|${args.runtimeHash}`;
  if (_warnedKeys.has(key)) return result;
  _warnedKeys.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[baked-model] ${args.modelName} is stale: ` +
      `model hash=${modelHash} vs runtime hash=${args.runtimeHash}. ` +
      `Run \`pnpm build-local-models\` to refresh.`,
  );
  return result;
}

/** Test seam — clear the warned-keys memo between tests. */
export function _clearStaleWarningCache(): void {
  _warnedKeys.clear();
}
