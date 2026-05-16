# Local Provider Speed — Plan D (baked master models via Ollama Modelfile)

**Status:** Draft · **Date:** 2026-05-16 · **Author:** alessio.danna.94@gmail.com
**Builds on:** [2026-05-16-local-ai-provider-design.md](./2026-05-16-local-ai-provider-design.md), [2026-05-16-local-tools-contextual-subset-design.md](./2026-05-16-local-tools-contextual-subset-design.md)

## Why this exists

Plan C (compact prompt toggle) attacked the local-LLM latency problem by **trimming the master system prompt** to imperative cheat-sheets. Smoke testing on `qwen3:30b` showed the new prompt was still **122 KB**, which Ollama processes for several minutes on the first cold turn — too slow to be usable. Even with Plan C ON, the static content (master handbook, world lore, SRD reference, tool contract, roll triggers, rewards mandate, base prompt) is **the dominant cost** and gets re-sent / re-evaluated whenever the KV cache prefix drifts.

The insight the user surfaced: **everything that's static across all campaigns can be baked into the model itself** via Ollama's Modelfile `SYSTEM` directive. The base model (qwen3:30b, qwen3:14b, gpt-oss:20b) becomes a personalised variant (`dnd-master-qwen3:30b`, etc.) that already "knows" the DM craft handbook, the world lore, and the SRD rules. At runtime we only send the **per-campaign / per-turn dynamic deltas** (~5-10 KB), which Ollama happily evaluates in 1-3 seconds on a warm cache.

**Critical design directive from the user**: do NOT use the compact (Plan C) variants of the handbook / world lore / SRD when baking. The whole point of Plan D is that we pay the cost *once* at build time, not per-turn — so we bake the **full high-fidelity content**, which gives the master the best narration quality without per-turn latency cost.

## Goals

1. Reduce the per-turn prompt sent to local Ollama from ~120 KB to ~5-10 KB by baking all static blocks (full handbook + full world lore + full SRD context + base prompt + tool contract + meta-tools instruction + roll triggers + rewards mandate + memory rule) into a customised model.
2. Keep all dynamic / per-campaign content (guidance level, narration pace, manual rolls, difficulty visibility, tonal frame, engagement profile, language hint, party mode, snapshot, scene card, codex index, chapter digests) as runtime system blocks — these vary per campaign and per turn and must not be baked.
3. Provide a `pnpm build-local-models` script that:
   - Reads the current static prompt content from the source tree + DB.
   - Generates a deterministic Modelfile per supported base model.
   - Calls `ollama create dnd-master-<base> -f Modelfile` for each.
   - Stamps a content hash into the Modelfile so we can detect "needs rebuild" later.
4. Detect baked models at runtime (`aiMasterModel` starts with `dnd-master-`) and skip the static system blocks for those turns.
5. Settings UI surfaces baked models as recommended options when present, with a clear "(optimized)" badge and a "build" hint when missing.

## Non-goals

- ❌ Auto-rebuild on prompt-source changes. The build is a manual step (or eventually CI / git pre-commit). Rebuilds happen on demand.
- ❌ Bake **tool definitions** into the model. Ollama doesn't expose a way to inline tool schemas in a Modelfile — tools must be sent in each `/api/chat` request. This is fine: the 8 meta-tools cost ~3-5 KB, well within budget.
- ❌ Bake **per-campaign settings** (guidance, language, tonal frame, ...). These vary per campaign and would require N variants per setting combination; not worth the build-matrix explosion.
- ❌ Replace cloud providers. Plan D is local-only. Cloud paths stay on the regular full-prompt-per-request model (Anthropic with cache_control is happy; OpenAI/Gemini have their own prompt-cache mechanisms).
- ❌ Bake content into models the user did not download. The script must enumerate models the user has via `ollama list` and only build variants for those.
- ❌ Force migration. Users who don't run the build script keep using the base models with the full per-request prompt. Backward-compatible by default.

## Architecture

### What gets baked into Modelfile SYSTEM

Below is the exact ordered concatenation that goes into the `SYSTEM` block of a `dnd-master-<base>` Modelfile. Each entry preserves its current source-of-truth and is read at build time.

| # | Source | Content | Approx size |
|---|---|---|---|
| 1 | `MASTER_SYSTEM_PROMPT_BASE` | "You are the Dungeon Master ..." role framing, multiplayer ground rules, image-gen contract | 5.7 KB |
| 2 | `MASTER_TOOL_CONTRACT` | when/how to call tools, roll formula conventions, NPC voicing tools | 14.4 KB |
| 3 | `MASTER_META_TOOLS_INSTRUCTION` | "this session runs on a local model, use meta-tools + subaction" | 1.8 KB |
| 4 | `MASTER_ROLL_TRIGGERS` | exhaustive list of when to call `ability_check` / `saving_throw` / `make_attack` | 4.7 KB |
| 5 | `MASTER_REWARDS_MANDATE` | "every dungeon ends with loot, here is the mandatory checklist" | 4.0 KB |
| 6 | `getMasterHandbook()` — **full**, not compact | DM Craft Handbook (5e DMG 2024 chapters 1-3) — 12 sections, 288 lines | 18.4 KB |
| 7 | `getMasterWorldLore()` — **full**, not compact | DM World & Lore Handbook (5e DMG 2024 chapters 4-7 + Lore Glossary) | 27.4 KB |
| 8 | `MASTER_MEMORY_TOOL_RULE` | when to record chapters, codex entries, scene cards | 1.1 KB |
| 9 | `buildSrdContext()` — **full**, not compact | All 88 rule docs + classes + races + backgrounds + conditions | ~28 KB |
| | **Static SYSTEM total** | | **~105 KB** |

Per the user's directive: every one of these is the **full** high-quality variant. Plan C compact variants are NOT used here — they remain available as a runtime fallback for users who haven't built a custom model yet (see "Plan C interaction" below).

### What stays in the runtime system prompt (per-request `system` parameter)

When the turn route detects `aiMasterModel` starts with `dnd-master-`, it builds a much smaller system prompt that ONLY contains per-campaign / per-turn content:

| # | Block | When emitted | Approx size |
|---|---|---|---|
| 1 | `MASTER_GUIDANCE_FREE` / `_BALANCED` / `_STRUCTURED` | always — picks one based on campaign setting | 0.8-2.1 KB |
| 2 | `MASTER_HIDE_DIFFICULTY_RULE` | only if `showDifficultyNumbers === false` | 1.0 KB |
| 3 | `MASTER_BRISK_PACING_RULE` | only if `narrationPace === 'brisk'` | 2.5 KB |
| 4 | `MASTER_MANUAL_ROLLS_RULE` | only if `manualRolls === true` | 7.0 KB |
| 5 | Tonal frame block | only if campaign has tonal frame set | 0.5 KB |
| 6 | Engagement profile hint | only if profiles detected | 0.3 KB |
| 7 | Language hint (Italian / English / ...) | always when campaign language set | 0.4 KB |
| 8 | Party mode block | only if multiplayer (party.length > 1) | 0.5-1 KB |
| 9 | Chapter digests | only if memory has accumulated chapters | 1-3 KB |
| 10 | Scene card | only if memory has scene card | 0.5-1 KB |
| 11 | Codex index | only if codex has entries | 0.5-2 KB |
| 12 | Dynamic tail (character JSON + scene) | always | 1-2 KB |
| | **Typical runtime total** | first turn (no memory) | **~3-5 KB** |
| | | mid-session (with memory) | **~7-12 KB** |

Plus the 8 meta-tools definitions in the `tools` array of the `/api/chat` request: **~4 KB**.

Grand total per Plan-D turn: **~7-16 KB**, of which ~5-10 KB is system blocks. Down from the current ~80-120 KB.

### Modelfile structure

The generated Modelfile looks like this (newlines / quotes preserved exactly):

```
# Generated by scripts/build-local-models.ts on 2026-05-16T...
# Source content hash: <sha256 of the concatenated static blocks>
# Base model: qwen3:30b
# Do NOT hand-edit — re-run `pnpm build-local-models` instead.

FROM qwen3:30b

PARAMETER num_ctx 65536
PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER repeat_penalty 1.1

SYSTEM """
<<<concatenation of blocks 1-9 from the table above, joined by \n\n>>>
"""
```

Notes:

- `num_ctx 65536` matches what the turn route currently sets explicitly. By baking it into the Modelfile, we avoid the "explicit param vs default override" foot-gun.
- Temperature / top_p / repeat_penalty come from a tuned set we'll codify in the script. Keep them per-base if profiling shows different bases prefer different defaults.
- `SYSTEM """ ... """` uses Ollama's triple-quote heredoc — handles embedded quotes / newlines / backticks without escaping each character.
- The hash comment is informational only. The script reads the *content* of the SYSTEM block back to recompute the hash, regardless of comments — so if a user hand-edits the Modelfile, the script catches drift.

### Build script: `scripts/build-local-models.ts`

Inputs:

- `MASTER_PROMPT_VERSION` constant (a simple integer, bumped manually when the static prompt content semantics change in a way that warrants forcing all users to rebuild).
- `BASE_MODELS_TO_BUILD` — a curated list of base model slugs we support: `['qwen3:14b', 'qwen3:30b-a3b', 'qwen3:30b', 'gpt-oss:20b']`.
- Live read of all 9 static blocks (5 constants from `system-prompt.ts`, `getMasterHandbook()`, `getMasterWorldLore()`, `MASTER_MEMORY_TOOL_RULE`, `buildSrdContext()` from `srd-context.ts` against the live DB).

Procedure for each base model:

1. Check `ollama list` — skip if base model not installed (warn + continue).
2. Concatenate the 9 static blocks → `systemContent`.
3. Compute `sha256(systemContent + MASTER_PROMPT_VERSION)` → `contentHash`.
4. If `ollama show dnd-master-<base> --modelfile` exists AND already has the same `contentHash` comment AND `--force` was not passed → skip ("up to date").
5. Write the Modelfile to a temp path (e.g. `.ollama/dnd-master-qwen3-30b.Modelfile`) — keep it for inspection.
6. Run `ollama create dnd-master-<base> -f <tempPath>`.
7. Report success / failure per base.

Script options:

- `--force` — rebuild even if hash matches.
- `--base <slug>` — only build a specific base model (skips the iteration).
- `--dry-run` — write Modelfiles to `./tmp/local-models/` but don't call `ollama create`.

Naming convention rationale:

- Format: `dnd-master-<base>` where `<base>` is the original tag with `:` swapped for `-` (`qwen3:30b` → `dnd-master-qwen3-30b`, `gpt-oss:20b` → `dnd-master-gpt-oss-20b`).
- Why not `dnd-master:qwen3-30b`? Because the tag part of an Ollama model name is treated like a version (`latest`, `v1`, ...); pushing campaign-specific content there breaks the mental model. The name is the brand, the tag is the variant. Using `:` would also collide with `dnd-master:latest` if we ever ship a default.
- Why `-` separator? Because Ollama allows `[a-z0-9_.-]` in model names. `qwen3:30b-a3b` → `qwen3-30b-a3b` (no ambiguity since `-a3b` is the original quant suffix).

### Runtime integration

The turn route at `src/app/api/sessions/[id]/turn/route.ts` already calls `buildMasterSystemPrompt`. We add:

```typescript
// New helper somewhere in src/lib/ai-models.ts (or a new src/ai/master/baked-models.ts)
export function isBakedModel(modelSlug: string): boolean {
  return modelSlug.startsWith('dnd-master-');
}
```

Then in the turn route, before calling `buildMasterSystemPrompt`:

```typescript
const baked = isBakedModel(userPrefs.aiMasterModel);

const sys = buildMasterSystemPrompt({
  ...currentInputs,
  // When the model is baked, the static blocks are already inside the model
  // weights — skip emitting them in the request. Pass empty strings so the
  // function's signature stays unchanged.
  srdContext: baked ? '' : srd,
  handbook: baked ? '' : handbook,
  worldLore: baked ? '' : worldLore,
  // Also tell the prompt builder to skip the 5 static prompt constants
  // (base, tool contract, meta-tools instruction, roll triggers, rewards mandate).
  // This is a new flag added to MasterPromptInput.
  staticBlocksAlreadyBaked: baked,
});
```

`buildMasterSystemPrompt` then learns one new conditional:

```typescript
if (!input.staticBlocksAlreadyBaked) {
  blocks.push(
    { type: 'text', text: MASTER_SYSTEM_PROMPT_BASE, cache_control: ... },
    { type: 'text', text: MASTER_TOOL_CONTRACT, cache_control: ... },
    ...(input.usesMetaTools ? [MASTER_META_TOOLS_INSTRUCTION block] : []),
    { type: 'text', text: MASTER_ROLL_TRIGGERS, cache_control: ... },
    { type: 'text', text: MASTER_REWARDS_MANDATE, cache_control: ... },
  );
  blocks.push({ type: 'text', text: input.handbook, cache_control: ... });
  blocks.push({ type: 'text', text: input.worldLore, cache_control: ... });
  blocks.push({ type: 'text', text: MASTER_MEMORY_TOOL_RULE, cache_control: ... });
  blocks.push({ type: 'text', text: input.srdContext, cache_control: ... });
}
// ── (2) STABLE PER SESSION — unchanged, always emitted regardless of baked.
// (manual rolls, guidance, hide-difficulty, brisk, tonal frame, engagement, langHint, ...)
// ── (3) PER-TURN DYNAMIC — unchanged, always emitted regardless of baked.
// (party mode, chapter digests, scene card, codex index, dynamic tail)
```

The `staticBlocksAlreadyBaked` flag is **independent** of `usesMetaTools`. They're set together for local-baked but they're conceptually distinct: `usesMetaTools` controls *which tools the LLM sees*, `staticBlocksAlreadyBaked` controls *which prompt blocks are emitted*. Keeping them separate makes Plan D testable in isolation.

### Settings UI

In `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`, when `aiProvider === 'local'` and `localServices.ai.reachable === true`, the model dropdown should:

1. Query `localServices.ai.models` (the auto-discovered list from `/api/tags`).
2. Identify which entries start with `dnd-master-` → these are the "baked" variants.
3. Render them at the top of the dropdown with an "(optimized)" suffix and a tooltip "Pre-built with the DM handbook + SRD — much faster responses."
4. Render the raw base models below them with a "(slow on long prompts)" hint.
5. If no `dnd-master-*` models exist, add a small note under the dropdown: "Run `pnpm build-local-models` in your terminal to enable optimized variants (~30s build, much faster turns)."

The Settings page does **not** need to know about Plan C compact toggle interactions — Plan D supersedes Plan C for users who have baked models. Plan C stays as the fallback for users who didn't build (see next section).

### Plan C interaction

Plan C (compact prompt toggle) and Plan D (baked models) attack the same problem from opposite ends:

- **Plan C compact** trims the static content to fit smaller models. Per-request prompt: ~85 KB (still big, but manageable on qwen3:14b once warm).
- **Plan D baked** moves the static content into the model itself. Per-request prompt: ~10 KB. Build step required.

The two **compose**, in the sense that Plan C-style "compact" content is irrelevant for Plan-D users (because the static content is already baked, the compact / full distinction has no effect on the per-request prompt — both are zero bytes in the request). However, Plan C provides value for two user paths:

1. The user hasn't run the build script yet → fall back to Plan C compact when `aiMasterModel` is a raw base model + `compactPrompt: true`.
2. The user is on a cloud provider but wants smaller prompts → flip Plan C compact on (already supported).

Recommended **default behaviour** after Plan D ships:

- `aiMasterModel.startsWith('dnd-master-')` → ignore `compactPrompt` entirely (logically irrelevant; both states behave identically because the static content is baked).
- `aiMasterModel === 'qwen3:14b'` or any raw local model → respect `compactPrompt`; default it to `true` for local as before.

This keeps Plan C as a safety net without contradicting Plan D.

### Invalidation + rebuild

When does the user need to rebuild?

- The 5 static prompt constants in `system-prompt.ts` change (anyone updating those bumps `MASTER_PROMPT_VERSION`).
- `data/master_handbook.md` or `data/master_world_lore.md` is edited.
- The SRD seed data is re-imported (new rules added → `buildSrdContext()` output changes).
- A new base model is downloaded (the user pulled `qwen3:32b` for the first time — re-run the script to build `dnd-master-qwen3-32b`).

How does the user / app know?

- **Manual**: the script's "skip if hash matches" check tells the user which variants are up to date and which are stale.
- **At runtime**: on the first turn after a deploy, the turn route compares the runtime's `MASTER_PROMPT_VERSION` against the `dnd-master-<base>` model's stamped version (read via `ollama show <model> --modelfile` and grep the comment line). If they differ, log a one-shot warning: `[turn] baked model stale (prompt v3 vs v4), run pnpm build-local-models` — but still proceed (degraded mode, the master will reason using the older baked prompt — not catastrophic, just outdated).
- A user-facing Settings UI note ("⚠ Your baked models are stale — rebuild for the latest DM guidance") is a nice-to-have but out of scope for the initial ship.

### Build matrix and resource cost

`ollama create` reads the SYSTEM block, runs the base model's tokenizer over it, stores the result in `~/.ollama/models/blobs/`. The actual disk overhead per baked variant is small (~5-10 MB for the metadata + tokenized system prefix; the base model weights are shared).

Build time per variant: ~10-30 seconds on M-series Mac (mostly I/O). The whole script across 3-4 bases finishes in under 2 minutes.

## Files touched

| Path | Change |
|---|---|
| `scripts/build-local-models.ts` (new) | The build script described above |
| `src/ai/master/baked-models.ts` (new) | `isBakedModel(slug): boolean`, `BAKED_PREFIX = 'dnd-master-'`, `getBakedBaseModel(slug): string \| null` |
| `src/ai/master/system-prompt.ts` | Add `staticBlocksAlreadyBaked?: boolean` to `MasterPromptInput`; gate blocks 1-5 + 6-9 (handbook, worldLore, memory rule, srdContext) on `!staticBlocksAlreadyBaked` |
| `src/app/api/sessions/[id]/turn/route.ts` | Detect baked model, pass `staticBlocksAlreadyBaked` + empty handbook/worldLore/srd strings |
| `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` | Promote baked variants in the model dropdown when present; show build-script hint when none |
| `src/lib/ai-models.ts` (or wherever model discovery lives for local) | When listing local models, surface a `kind: 'baked' \| 'raw'` discriminator so the UI can group them |
| `package.json` | Add `"build-local-models": "tsx scripts/build-local-models.ts"` |
| `docs/superpowers/specs/2026-05-16-local-baked-models-design.md` (this file) | The spec |
| `docs/superpowers/plans/2026-05-16-local-baked-models.md` (new) | The execution plan with task-by-task breakdown |
| `tests/scripts/build-local-models.test.ts` (new) | Modelfile generation determinism + hash stability |
| `tests/ai/master/baked-models.test.ts` (new) | `isBakedModel` + dropdown grouping logic |
| `tests/ai/master/system-prompt.test.ts` | New tests: when `staticBlocksAlreadyBaked: true`, blocks 1-5 + 6-9 are omitted; blocks 10+ still emitted |
| `tests/api/turn-baked.test.ts` (new) | Integration test: turn with `aiMasterModel='dnd-master-qwen3-30b'` builds the right minimal system prompt |

## Tasks

**Task 1**: Write the helper module `src/ai/master/baked-models.ts`

- `export const BAKED_PREFIX = 'dnd-master-';`
- `export function isBakedModel(slug: string): boolean { return slug.startsWith(BAKED_PREFIX); }`
- `export function getBakedBaseModel(slug: string): string | null` — strips the prefix and tries to recover the original base slug by reversing the `-` → `:` swap *only for the first `-`* (because base names can themselves contain `-`). Examples: `dnd-master-qwen3-30b` → `qwen3:30b`, `dnd-master-qwen3-30b-a3b` → `qwen3:30b-a3b`, `dnd-master-gpt-oss-20b` → `gpt-oss:20b`. The first `-` after the prefix is the separator that was originally `:`.

Edge case: `dnd-master-qwen3-30b-a3b` is ambiguous in principle (`qwen3:30b-a3b` vs `qwen3-30b:a3b`). We resolve by the rule "the first dash after the prefix is the `:` separator". Document this in the function and ensure the build script generates names following the rule.

**Task 2**: Add `MASTER_PROMPT_VERSION` constant in `src/ai/master/system-prompt.ts`

- A single integer exported at the top of the file. Initial value: `1`.
- Bumped manually when any of the 5 static constants OR the bake-ordering logic changes meaningfully.
- The build script reads it; the runtime can compare it against what's stamped in `ollama show`.

**Task 3**: Add `staticBlocksAlreadyBaked` to `MasterPromptInput` + gate blocks

- New optional boolean on `MasterPromptInput`, default `false`.
- When `true`, the `buildMasterSystemPrompt` function skips:
  - `MASTER_SYSTEM_PROMPT_BASE`
  - `MASTER_TOOL_CONTRACT`
  - `MASTER_META_TOOLS_INSTRUCTION` block (even if `usesMetaTools` is true — it's baked)
  - `MASTER_ROLL_TRIGGERS`
  - `MASTER_REWARDS_MANDATE`
  - `input.handbook`
  - `input.worldLore`
  - `MASTER_MEMORY_TOOL_RULE`
  - `input.srdContext`
- Everything below ( guidance / manual rolls / hide-difficulty / brisk / tonal / engagement / langHint / party / chapter digests / scene card / codex index / dynamic tail) is **always** emitted regardless of `staticBlocksAlreadyBaked` — those are per-campaign / per-turn.
- The function signature stays backward-compatible (existing callers without the flag get the current behaviour).

**Task 4**: Wire the flag at the turn route

- `src/app/api/sessions/[id]/turn/route.ts`: import `isBakedModel`, compute `const baked = isBakedModel(userPrefs.aiMasterModel)`.
- Pass `staticBlocksAlreadyBaked: baked` to `buildMasterSystemPrompt`.
- When `baked === true`, pass empty strings for `srdContext`, `handbook`, `worldLore` to skip the I/O cost of `buildSrdContext()` + `getMasterHandbook()` + `getMasterWorldLore()` entirely (small saving but principled — don't read from disk if we won't use it).
- When `baked === false`, the Plan C `compactPrompt` resolution still applies (load compact variants for local-without-baked, full variants for cloud).

**Task 5**: Build script `scripts/build-local-models.ts`

The script's main responsibilities, in order:

1. Parse CLI args (`--force`, `--base <slug>`, `--dry-run`).
2. Verify Ollama is reachable (`ollama list` or `GET /api/tags`). If unreachable, exit with a clear error.
3. Read installed base models from Ollama; intersect with the curated `BASE_MODELS_TO_BUILD` list.
4. Boot the Next.js DB connection (`@/db/client`) so `buildSrdContext()` can run. Use the same env loading as Vitest (read `.env.local` etc.).
5. Build the static SYSTEM string by concatenating the 9 blocks in the exact order from the "What gets baked" table.
6. Compute the content hash: `sha256(systemContent + '\n' + MASTER_PROMPT_VERSION)`.
7. For each base model:
   - Check if `dnd-master-<base-normalized>` already exists with matching hash → skip (unless `--force`).
   - Generate the Modelfile body.
   - Write to `.ollama/dnd-master-<base-normalized>.Modelfile` (relative to repo root, gitignored).
   - Shell out: `ollama create dnd-master-<base-normalized> -f <path>`.
   - Capture stdout/stderr; report success or surface the error.
8. Print a summary table: `<base>: built | up-to-date | failed: <reason>`.
9. Exit 0 if all variants built or up-to-date; exit 1 if any failed.

Add the npm script: `"build-local-models": "tsx scripts/build-local-models.ts"`.

Also add `.ollama/*.Modelfile` to `.gitignore`.

**Task 6**: Settings UI — surface baked variants

- `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`: in the model `<select>`, when `settings.aiProvider === 'local'`:
  - Split `availableModels` into two groups: baked (slug starts with `dnd-master-`) and raw.
  - Render baked group first under a `<optgroup label="Optimized (built locally)">`.
  - Render raw group under `<optgroup label="Base models (slower)">`.
  - Each baked option's label: `<base> (optimized)` — e.g. `qwen3:30b (optimized)`.
- If `baked.length === 0`, render a small text below the select: "💡 Run `pnpm build-local-models` to enable optimized variants (~30s build, 10× faster turns)."
- No new endpoint required — model discovery already runs server-side and the list is passed as a prop to this component.

**Task 7**: `src/lib/ai-models.ts` (or wherever the local-model list is filtered)

- Currently the local model whitelist excludes anything that doesn't match `qwen3*` / `gpt-oss*`. Update it to ALSO accept `dnd-master-*`.
- Add a `kind: 'baked' | 'raw'` field on each entry, derived from `isBakedModel(slug)`. Pass it through to the UI so the settings dropdown can split into optgroups without re-implementing detection.

**Task 8**: Stale-model warning at runtime

- After a successful baked-model turn (`isBakedModel(model) === true`), in the background (Vercel `waitUntil` or a fire-and-forget promise), call `GET /api/tags` once per N minutes to read the Modelfile and parse the `# Source content hash:` comment.
- If the hash doesn't match the current build-time hash, log a single warning line: `[turn] baked model <slug> is stale (current hash=..., model hash=...), run pnpm build-local-models`.
- Cache the "already warned for this slug + this hash combo" decision in module memory so we don't spam every turn.
- This is logging-only for the initial ship; surfacing it in the UI is a future enhancement.

**Task 9**: Tests

- `tests/ai/master/baked-models.test.ts`: 
  - `isBakedModel('dnd-master-qwen3-30b')` → true; `isBakedModel('qwen3:30b')` → false.
  - `getBakedBaseModel('dnd-master-qwen3-30b')` → `'qwen3:30b'`.
  - `getBakedBaseModel('dnd-master-qwen3-30b-a3b')` → `'qwen3:30b-a3b'`.
  - `getBakedBaseModel('dnd-master-gpt-oss-20b')` → `'gpt-oss:20b'`.
  - `getBakedBaseModel('qwen3:30b')` → `null`.

- `tests/ai/master/system-prompt.test.ts` (extend existing file): 
  - With `staticBlocksAlreadyBaked: true`, the returned `system` array does NOT contain any text that includes `MASTER_SYSTEM_PROMPT_BASE`'s opening line, the tool contract, roll triggers, rewards mandate, handbook, world lore, memory rule, or srd context.
  - With `staticBlocksAlreadyBaked: true`, the returned `system` array DOES contain the guidance block, language hint (if set), and dynamic tail.
  - Cloud-provider behaviour (default `staticBlocksAlreadyBaked: false`) is byte-for-byte unchanged from current.

- `tests/scripts/build-local-models.test.ts`: 
  - Modelfile generator is deterministic given fixed inputs (no timestamps inside the SYSTEM block — only in the leading comment).
  - The content hash is stable across runs given the same inputs.
  - The CLI parses `--force`, `--base`, `--dry-run` correctly.
  - In `--dry-run` mode no `ollama create` is invoked.
  - The script handles "base model not installed" gracefully (warns, continues).

- `tests/api/turn-baked.test.ts` (new): integration test using the test DB.
  - Seed a campaign with `aiMasterModel='dnd-master-qwen3-30b'`.
  - Trigger a turn (mock Ollama at the HTTP layer so we don't need it actually running).
  - Assert: the request body sent to Ollama has a `system` field of length < 15 KB (vs ~120 KB without baking).
  - Assert: the request body's `system` does NOT contain "DM Craft Handbook" or the SRD's "Rules reference" marker.
  - Assert: the request body's `system` DOES contain the guidance level block and the dynamic tail.

**Task 10**: Manual smoke test

- Run `pnpm build-local-models`. Verify it produces `dnd-master-qwen3-30b` in `ollama list`.
- In Settings, switch the model from `qwen3:30b` to `dnd-master-qwen3-30b`. Save.
- Start a new turn. Check the dev-server log for `[ollama-start] sys[len=...]` — should be < 15 KB.
- Verify the turn completes in under 10 seconds on a warm cache.
- Spot-check narration quality: the master should still cite proper DM craft (rolls when appropriate, narrative pacing, rewards at the end of an encounter). If quality regresses despite identical content, the bake order is wrong somewhere.

**Task 11**: Update Plan C resolution to defer to Plan D

- In `src/lib/preferences.ts`, the `compactPrompt` resolution stays as-is (default-from-provider rule). But the turn route's behaviour changes: if `isBakedModel(model)`, the `compactPrompt` value is functionally ignored (the static blocks are baked, the compact / full distinction has no observable effect). No code change needed — this happens automatically because we skip those blocks entirely.
- Document this in the design doc + (optional) add a note in the Settings UI tooltip near the compact-prompt toggle: "Has no effect when using an optimized (`dnd-master-*`) model."

**Task 12**: Update README + AGENTS.md

- Add a section "Local AI: building optimized master models" with:
  - When to run it (first-time setup + after pulling new base models + after the app updates the static prompts).
  - What it does (one paragraph).
  - The command (`pnpm build-local-models`).
  - Troubleshooting (Ollama not running, base model missing, hash mismatch warning).

## Testing strategy

- **Unit**: tasks 9.a (baked-models helpers), 9.b (system-prompt branching), 9.c (build script logic).
- **Integration**: task 9.d (turn route end-to-end with mocked Ollama, asserting the request body shape).
- **Manual smoke**: task 10 (build a model, send a turn, measure latency).
- **Regression**: task 9.b's "cloud-provider behaviour byte-for-byte unchanged" assertion is the critical guardrail. Plan D must NEVER alter what cloud providers see.

A pre-flight check before the smoke test: run the full vitest suite. The 3 known baseline failures (live-smoke without API key, tts-coalesce flake, inventory applicator) should remain the only failures.

## Risks

1. **Bake matrix explosion if we ever per-language-bake.** Mitigation: explicitly out-of-scope. Language stays dynamic.
2. **Hash drift causing silent quality regression** if a user forgets to rebuild after a prompt update. Mitigation: the runtime stale-model warning (Task 8) gives a visible log line, and the spec calls out manual rebuild as part of the deploy workflow.
3. **Ollama `SYSTEM` directive size limit.** Empirically Ollama handles `SYSTEM """ ... """` blocks of hundreds of KB without issue (the limit is the model's `num_ctx`, not the Modelfile parser). We're well within `num_ctx=65536` even with ~30K tokens of baked content. If it ever blows up at build time, the script should report the exact byte / token count and exit with a useful error.
4. **`ollama create` race vs concurrent turns.** While the script is rebuilding `dnd-master-qwen3-30b`, an in-flight turn could call the half-built model. Mitigation: `ollama create` overwrites atomically (it writes to a temp blob and renames at the end). Worst case: the in-flight turn fails with a 404 (model not found mid-write), the SSE shows an error to the user, the next turn works. Acceptable trade-off — the build is a manual one-time op, not a hot path.
5. **User on `aiMasterModel='dnd-master-qwen3-30b'` who never built it.** The turn route hits Ollama, gets `404 model not found`, returns an error. Mitigation: at turn start, before calling Ollama, check `localServices.ai.models` for the slug. If missing, return a friendly error like "Optimized model not built — run `pnpm build-local-models`" and don't even fire the Ollama request. Out of scope for v1 (acceptable to surface the raw 404 in the dev console) but easy to add later.
6. **The bake order in the Modelfile differs from the runtime order if someone reorganises `buildMasterSystemPrompt` blocks 1-5/6-9.** Mitigation: the bake script imports the SAME constants from the SAME module — there's no separate copy of the content. As long as the script's concatenation order matches the function's emit order for those 9 blocks, they stay in sync. Pin both via a shared `STATIC_PROMPT_BLOCKS` helper if the future drift risk feels real.

## Out of scope (revisit later)

- Auto-rebuild on file change (a watcher that runs the build script when `src/ai/master/system-prompt.ts` is edited).
- Bake the per-campaign settings (guidance, tonal frame, pace, ...) as additional variants. Build-matrix explosion: 3 guidance × 2 difficulty × 2 pace × 2 manual = 24 variants per base model.
- Ship the baked models as Ollama-Hub-distributable artifacts so users don't have to build locally. Possible if the user community grows, but not for the single-developer-machine case we're solving.
- Sign / verify the Modelfile content hash with a cryptographic signature. Not a security concern for the local-only use case.
- Migrate the Plan C compact prompt fallback to a graceful "auto-detect: prefer baked if present, fall back to compact if not". Currently the user has to pick which model to use; future UX could auto-pick.

## Expected impact

| Scenario | Per-turn prompt | First-turn latency (qwen3:30b cold) | Warm-turn latency (qwen3:30b cache hit) |
|---|---|---|---|
| Current (no Plan B, no Plan C, no Plan D) | ~140 KB | timeout-ish (>2 min) | ~50-90s |
| Plan B alone (meta-tools) | ~125 KB | similar | ~40-70s |
| Plan B + Plan C compact | ~85 KB | ~60-120s | ~25-50s |
| **Plan B + Plan D baked** | **~7-15 KB** | **~5-10s** | **~2-5s** |

The Plan D row assumes the baked model is fully loaded into RAM (Ollama keeps it warm via `keep_alive`), which is the case after the first call. If the model gets evicted (idle > `keep_alive`), the first call after eviction has a ~2-5s reload cost on top — still much faster than the current 50-90s warm-turn baseline.

## Estimated effort

- Task 1 (baked-models helper): 30 min
- Task 2 (`MASTER_PROMPT_VERSION` constant): 10 min
- Task 3 (gate static blocks): 1h
- Task 4 (wire turn route): 30 min
- Task 5 (build script): 3-4h
- Task 6 (Settings UI): 1h
- Task 7 (model-list integration): 30 min
- Task 8 (stale-model runtime warning): 1h
- Task 9 (tests): 2-3h
- Task 10 (manual smoke): 30 min hands-on
- Task 11 (Plan C deferral docs): 15 min
- Task 12 (README + AGENTS.md update): 30 min

**Total**: ~10-12 hours of focused work, single developer. Plan B + Plan C were ~12 hours for context; Plan D is similar but with the build script being the bulk of the work.
