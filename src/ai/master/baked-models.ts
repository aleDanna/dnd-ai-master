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
 * Phase 03 cutover (REQ-033 + Decision 8): the curated TIER_NAMES set was
 * stripped down to ONLY `dnd-master-plus` (gpt-oss:20b + quantizations),
 * which we keep as a regression baseline for spike-004-style A/B tests
 * against the vault path. The previously-baked Max / Max 2 / Max 3 / Lite
 * tiers (mistral-small3.2:24b, qwen3:30b-a3b-instruct-2507, qwen3:30b-a3b,
 * llama3.2:3b) are retired — they remain selectable as raw BASE slugs in
 * Settings (the vault path runs them un-baked, REQ-030/031/032). The
 * helpers in this file (`isBakedModel`, `getBakedBaseModel`,
 * `getBakedModelName`, `LARGE_MODEL_BASES`) still recognise the legacy
 * prefix and legacy base slugs so any stale `userPrefs.aiMasterModel`
 * value pointing at a retired tier degrades gracefully until plan 03-C-05
 * migrates it.
 *
 * See docs/superpowers/specs/2026-05-16-local-baked-models-design.md.
 * See .planning/phases/03-migration-cutover/03-RESEARCH.md (Decision 8).
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
 * Phase 03 (Decision 8 + REQ-033) — TIER_NAMES contains ONLY dnd-master-plus
 * (the regression-test baseline; gpt-oss:20b + its q4_K_M/q8_0 quantizations).
 *
 * RETIRED in Phase 03:
 *  - dnd-master-lite  (llama3.2:3b)                                — out of selector
 *  - dnd-master-max   (mistral-small3.2:24b)                       — out of selector
 *  - dnd-master-max2  (qwen3:30b-a3b-instruct-2507 + quantizations) — out of selector
 *  - dnd-master-max3  (qwen3:30b-a3b + quantizations)              — out of selector
 *
 * The base slugs (e.g., `qwen3:30b-a3b-instruct-2507-q4_K_M`, REQ-030 primary;
 * `mistral-small3.2:24b`, REQ-032 offline content tool) are selected DIRECTLY
 * as `userPrefs.aiMasterModel` — they no longer require a baked variant
 * because Phase 01 vault path runs them as base slugs.
 *
 * Phase 03-C-05 migrates stale `userPrefs.aiMasterModel` values that still
 * point at retired tier names back to the production primary base slug.
 *
 * Phase 03-C-06 documents `ollama rm dnd-master-{lite,max,max2,max3}` for
 * SSD reclaim on M4 (operator-run on the production host).
 *
 * Graceful-degradation note: `isBakedModel`, `getBakedBaseModel`, and
 * `getBakedModelName` still recognise the `dnd-master-` prefix and the
 * legacy slug-derived naming, so a stored userPrefs value of
 * `dnd-master-max2:latest` (or any other retired tier) resolves via the
 * fallback inverse-prefix logic until the 03-C-05 migration cleans it up.
 */
export const TIER_NAMES: Record<string, string> = {
  // GPT-OSS 20B — Plus tier (REGRESSION BASELINE per REQ-033; kept ONLY for
  // spike-004-style A/B tests against the vault path).
  'gpt-oss:20b':                           'dnd-master-plus',
  'gpt-oss:20b-q4_K_M':                    'dnd-master-plus',
  'gpt-oss:20b-q8_0':                      'dnd-master-plus',
};

/**
 * Reverse map of TIER_NAMES, populated lazily for O(1) lookup.
 *
 * Each tier name maps to MULTIPLE base slugs (canonical + quantizations:
 * `gpt-oss:20b` + `gpt-oss:20b-q4_K_M` + `gpt-oss:20b-q8_0` all bake to
 * `dnd-master-plus`). The reverse direction is many-to-one: we want the
 * CANONICAL (un-quantized) base slug so consumers like
 * `runtime-prompt-hash.ts` and `isLargeModelBase()` can match against the
 * `LARGE_MODEL_BASES` Set (which holds canonical slugs only — adding
 * quantization variants there would double the maintenance surface).
 *
 * Iteration preserves insertion order in `Object.entries`, so the FIRST
 * base slug listed under each tier wins. TIER_NAMES is hand-written with
 * the canonical slug first; the `if (!has)` guard makes that contract
 * explicit and survives a future reordering.
 */
const TIER_BASES: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [base, tier] of Object.entries(TIER_NAMES)) {
    if (!m.has(tier)) m.set(tier, base);
  }
  return m;
})();

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

/**
 * Resolve the right value of Ollama's top-level `think` flag for a given
 * model slug. Returns:
 *
 *   true       — qwen3:30b-a3b family (Max 3 tier). Forces thinking ON
 *                so the chain-of-thought head emits <think>…</think> the
 *                adapter strips before showing the player.
 *   false      — other qwen3 thinking bases, deepseek-r1, gpt-oss.
 *                Forces thinking OFF.
 *   undefined  — non-thinking bases (qwen3-*-instruct-*, mistral,
 *                llama3.x, …). Omits the flag entirely so we don't
 *                invalidate the KV cache.
 *
 * Used by:
 *  - local.ts → as the chat-request `think` value
 *  - turn route → to derive the `thinkingEnabled` flag that gates the
 *    MASTER_BRIEF_THINKING_RULE block in buildMasterSystemPrompt
 */
export function thinkingFlagFor(model: string | undefined): boolean | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  // Resolve baked variants (tier names + legacy slug-derived) to their
  // underlying base slug, then match families.
  const resolved = isBakedModel(m) ? (getBakedBaseModel(m) ?? m) : m;
  const r = resolved.toLowerCase();
  // Max 3 tier: qwen3:30b-a3b base (incl. quantization variants).
  if (/^qwen3:30b-a3b(?:-(?:q4_k_m|q8_0|fp16))?$/i.test(r)) return true;
  // Qwen3 non-thinking instruct (e.g. qwen3:30b-a3b-instruct-2507).
  if (/qwen3.*-instruct-/i.test(r)) return undefined;
  // Other qwen3 thinking + deepseek-r1 + gpt-oss: force OFF.
  if (r.startsWith('qwen3') || r.includes('/qwen3') || r.includes('qwen3')
    || r.startsWith('deepseek-r1') || r.includes('deepseek-r1')
    || r.startsWith('gpt-oss') || r.includes('/gpt-oss') || r.includes('gpt-oss')) {
    return false;
  }
  return undefined;
}

/**
 * True for local models that are WEAK at structured tool use — they leak
 * markerless chain-of-thought (no <think> tags) or melt down into garbage when
 * handed the vault tool surface and reason about how to call `apply_event`
 * (spike-findings: gemma narrates well but is unreliable on tools; operator
 * reports 2026-06-04: CoT leak + JAVADOC meltdown + "scatto" junk monster).
 *
 * The turn route forces narration-only (offerTools:false) on EVERY turn for these
 * models — not just combat/begin/roll turns — so the model is a PURE NARRATION
 * layer and the server owns all combat mechanics (opener/resolver/monster-loop).
 *
 * NOT weak: qwen3-a3b-instruct (spike-validated 100% tool compliance) and cloud
 * models (anthropic/openai/gemini), which use tools reliably. Trade-off for weak
 * models: they never read the vault (lore comes from the system prompt) and never
 * apply non-combat events — acceptable when the operator picks them for narration.
 */
export function isWeakToolModel(model: string | undefined): boolean {
  if (!model) return false;
  // gemma family (gemma4:12b-mlx, gemma4:latest, gemma2/3, …). Add other weak
  // local bases here if they exhibit the same CoT-leak-on-tools behaviour.
  return /\bgemma/i.test(model.toLowerCase());
}
