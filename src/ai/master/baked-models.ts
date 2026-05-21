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
 * Bases that get the LEAN baked manifest (no MASTER_HANDBOOK_ULTRA_SLIM).
 *
 * Rationale: >=7B models internalised D&D craft fundamentals (pacing,
 * NPC voice, don't-railroad pitfalls) from pretraining + they reliably
 * retrieve specifics via the RAG handbook chunks when needed. Saving the
 * 400-tok always-on summary is pure win for them.
 *
 * Smaller bases (3-4B llama/qwen/gemma) keep the ultra-slim block as a
 * guard-rail — they lean harder on the prompt to stay disciplined and
 * the 400-tok cost is worth the predictability.
 *
 * Match is on the BASE slug (e.g. `qwen3:30b`), NOT the baked variant
 * (`dnd-master-qwen3-30b`). Callers should go through `getBakedBaseModel()`
 * first when checking a baked-variant name.
 */
export const LARGE_MODEL_BASES = new Set<string>([
  'qwen3:30b',
  'qwen3:30b-a3b',
  'qwen3:30b-a3b-instruct-2507',
  'gpt-oss:20b',
  'mistral-small3.2:24b',
]);

/** True iff this base model is in the "large enough to skip ultra-slim" set. */
export function isLargeModelBase(baseSlug: string): boolean {
  return LARGE_MODEL_BASES.has(baseSlug);
}

/**
 * Curated tier names for the baked variants the user actually picks from
 * in Settings. Maps base slug → short, speaking name. Models not in this
 * map fall back to the legacy `dnd-master-<slug>` naming so nothing
 * breaks for in-progress development variants.
 *
 * Tier philosophy (multi-language campaigns, M-series Mac):
 *  - Max:    mistral-small3.2:24b           — strong multilingual narration + native tool-calling, dense 24B
 *  - Max 2:  qwen3:30b-a3b-instruct-2507    — MoE 30B/3B-active non-thinking instruct, fastest at this quality tier
 *  - Plus:   gpt-oss:20b                    — solid tool-calling fallback
 *
 * Bases outside the curated tiers (small <7B models, reasoning-only models)
 * still get baked under the legacy slug-derived name (e.g.
 * `dnd-master-llama3-2-3b`) if the user installs them, and surface in
 * Settings without a polished label.
 */
export const TIER_NAMES: Record<string, string> = {
  // Mistral Small 3.2 24B — Max tier (multilingual narration + native tool-calling)
  'mistral-small3.2:24b':                  'dnd-master-max',
  // Qwen3 30B-A3B Instruct — Max 2 tier (MoE, fastest at this quality)
  // Map both the canonical tag and the explicit-quantization variants users
  // commonly pull (q4_K_M / q8_0 / fp16). Without these the bake script
  // creates a slug-derived name like `dnd-master-qwen3-30b-a3b-instruct-2507-q4_K_M`
  // that surfaces in Settings as a confusing duplicate next to "D&D Master Max 2".
  'qwen3:30b-a3b-instruct-2507':           'dnd-master-max2',
  'qwen3:30b-a3b-instruct-2507-q4_K_M':    'dnd-master-max2',
  'qwen3:30b-a3b-instruct-2507-q8_0':      'dnd-master-max2',
  'qwen3:30b-a3b-instruct-2507-fp16':      'dnd-master-max2',
  // Qwen3 30B-A3B (thinking-mode MoE base) — Max 3 tier. Same underlying
  // architecture as the instruct-2507 sibling but the base variant has the
  // chain-of-thought head active. The runtime sends `think: false` so the
  // model behaves like an instruct variant in practice, while the broader
  // pretraining of the thinking head can occasionally yield more
  // creative narration. Kept as a separate tier so users can install
  // both side-by-side and pick from the dropdown.
  'qwen3:30b-a3b':                         'dnd-master-max3',
  'qwen3:30b-a3b-q4_K_M':                  'dnd-master-max3',
  'qwen3:30b-a3b-q8_0':                    'dnd-master-max3',
  'qwen3:30b-a3b-fp16':                    'dnd-master-max3',
  // GPT-OSS 20B — Plus tier (solid tool-calling fallback)
  'gpt-oss:20b':                           'dnd-master-plus',
  'gpt-oss:20b-q4_K_M':                    'dnd-master-plus',
  'gpt-oss:20b-q8_0':                      'dnd-master-plus',
  // Llama 3.2 3B — Lite tier (fast iteration, less reliable on long prompts)
  'llama3.2:3b':                           'dnd-master-lite',
};

/** Reverse map of TIER_NAMES, populated lazily for O(1) lookup. */
const TIER_BASES: Map<string, string> = new Map(
  Object.entries(TIER_NAMES).map(([base, tier]) => [tier, base]),
);

/**
 * Display labels for tier baked variants. Maps the Ollama model name
 * (without :latest suffix) to a human-readable form for the Settings UI.
 * A digit-run in the suffix is split off with a space so `max2` reads as
 * "Max 2" (variant tiers like `max2`, `plus2`, ...).
 *
 *   'dnd-master-max'   → 'D&D Master Max'
 *   'dnd-master-max2'  → 'D&D Master Max 2'
 *   'dnd-master-plus'  → 'D&D Master Plus'
 */
export const TIER_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(TIER_NAMES).map((tier) => {
    const suffix = tier.replace(/^dnd-master-/, '').replace(/(\d+)/, ' $1');
    const capitalised = suffix.charAt(0).toUpperCase() + suffix.slice(1);
    return [tier, `D&D Master ${capitalised}`];
  }),
);

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
  // Tier names (dnd-master-max, dnd-master-plus, ...) win over the
  // legacy slug-derived naming.
  const bareSlug = slug.replace(/:latest$/, '');
  const tierBase = TIER_BASES.get(bareSlug);
  if (tierBase) return tierBase;
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
  // Curated tier name wins for the bases listed in TIER_NAMES.
  const tier = TIER_NAMES[baseSlug];
  if (tier) return tier;
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
