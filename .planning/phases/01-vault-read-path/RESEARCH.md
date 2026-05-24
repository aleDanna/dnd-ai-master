# Phase 01: Vault Read Path — Research

**Researched:** 2026-05-24
**Domain:** Next.js + Ollama integration; markdown vault as static-knowledge layer behind a feature flag
**Confidence:** HIGH (codebase verified; spike findings auto-loaded via `spike-findings-dnd-ai-master` skill)

## Summary

Phase 01 wires the validated vault read path into the existing Next.js turn route behind a per-campaign `masterBackend` flag, leaving the baked+RAG path completely untouched. The vault tools, the pure-function `SystemPromptBuilder`, and the static-content migration are all greenfield (no equivalent code exists today). The integration surface is small: one new branch in `turn/route.ts`, a new tool-loop variant that exposes 4 vault tools, and a one-shot migration script that splits `data/master_handbook.md` + `data/master_world_lore.md` into per-entity files under `data/vault/handbook/`. Everything else (engine tools, baked variants, RAG modules, `ai_usage` schema) keeps working unchanged.

**Primary recommendation:** add a `masterBackend: 'vault' | 'baked'` field to `CampaignSettings`, default `'baked'`; branch in `turn/route.ts` step 4-5 selects either the existing baked path or the new vault path (built from `prompt-builder.ts` + a vault-aware fork of `runToolLoop`). The new files live under `src/ai/master/vault/` so they're discoverable as a unit. Migration is one-shot via `scripts/migrate-handbook-to-vault.ts` — handbook+lore H2/H3 structure cleanly maps to the canonical `/handbook/<category>/<id>.md` taxonomy. SRD content stays in Postgres for now (Phase 02 decision).

## User Constraints (from CONTEXT.md)

No CONTEXT.md exists for this phase. All requirement constraints come from `.planning/REQUIREMENTS.md` (REQ-001..REQ-034) which are LOCKED by spike validation. Phase 01 must respect: REQ-001, REQ-002, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-021, REQ-022, REQ-030, REQ-033.

## Project Constraints (from CLAUDE.md / AGENTS.md)

- **Next.js is non-standard in this repo.** AGENTS.md states "This is NOT the Next.js you know" — APIs and conventions may differ from public docs. Before touching any Next.js convention (route handlers, middleware, edge runtime, etc.), read the relevant guide in `node_modules/next/dist/docs/`. The existing `turn/route.ts` uses `waitUntil` from `@vercel/functions` and `auth()` from `@clerk/nextjs/server` — both already wired; Phase 01 doesn't need new Next.js APIs.
- User chat language: Italian. Code, commits, file names, doc files: English. RESEARCH.md and PLAN.md stay English.

## Phase Requirements

| ID | Description (from REQUIREMENTS.md) | Research support |
|---|---|---|
| REQ-001 | Vault is filesystem-only markdown | `data/vault/` greenfield; mirrors `sources/001-vault-harness-bootstrap/vault/` layout |
| REQ-002 | Static path-deterministic: `/handbook/<category>/<id>.md` | Migration step 3 below maps existing H2 sections to categories |
| REQ-010 | Fixed 4 tools: `read_vault_multi`, `list_vault`, `apply_event`, `end_turn` | Phase 01 ships read_vault_multi + list_vault + end_turn only; apply_event is Phase 02 |
| REQ-011 | NEVER expose singular `read_vault(path)` | Tool registration in step 4 below uses array-only schema |
| REQ-012 | Lenient discovery: read `/tools/index.md` once at session start | System prompt mentions the index file by path only; per-tool docs optional |
| REQ-013 | Accept BOTH terminators (`end_turn` AND `no_tool_calls + content`) | Existing `runToolLoop` line 180 already accepts both; reuse |
| REQ-014 | `safeVaultPath()` on every vault read | New `src/ai/master/vault/path.ts` — pattern from `tool-surface.md` |
| REQ-021 | Warm wall-clock < 10s on M4 | Validated via existing `ai_usage.prompt_eval_duration_ms` + `eval_duration_ms` |
| REQ-022 | Pure-function prompt builder + CI lint | New `src/ai/master/vault/prompt-builder.ts` + Vitest test |
| REQ-030 | Primary model: `qwen3:30b-a3b-instruct-2507-q4_K_M` | Already mapped to `dnd-master-max2` in `TIER_NAMES`; vault path uses BASE slug directly (not baked) |
| REQ-033 | Drop `dnd-master-*` baked variants from prod | Out of scope for Phase 01 (Phase 03); flag-gated vault path coexists |

## 1. Code-touch Map

| File (absolute) | Touch | Why |
|---|---|---|
| `src/db/schema/campaigns.ts` | **MODIFY** | Add `masterBackend?: 'vault' \| 'baked'` to `CampaignSettings` interface (no DB migration needed — JSONB column) |
| `src/db/schema/users.ts` | **MODIFY** (optional) | Mirror `masterBackend` default at user level if we want a global preference; otherwise leave at campaign level only |
| `src/lib/preferences.ts` | **MODIFY** | Resolve `masterBackend` from campaign settings → user prefs → env (`MASTER_BACKEND`) → default `'baked'`. Validate in `parsePreferencesBody` |
| `src/app/api/sessions/[id]/turn/route.ts` | **MODIFY** | Add a branch after `userPrefs` resolution (~line 244): if `masterBackend === 'vault'` route to the new vault flow; otherwise the existing baked+RAG flow runs unchanged |
| `src/ai/master/tool-loop.ts` | **READ-ONLY** | Reuse `runToolLoop` if the vault path uses the same provider abstraction. The 4 vault tools are NOT in `TOOL_HANDLERS` — they need a new handler injection mechanism OR a thin wrapper loop (see Section 4) |
| `src/ai/master/system-prompt.ts` | **READ-ONLY** | Not invoked by vault path. Stays for baked path |
| `src/ai/master/slim-prompts.ts` | **READ-ONLY** | Not invoked by vault path |
| `src/ai/master/baked-models.ts` | **READ-ONLY** | `isBakedModel()` stays — used to choose baked vs non-baked path; for vault we pass the BASE slug (`qwen3:30b-a3b-instruct-2507-q4_K_M`), never a `dnd-master-*` variant |
| `src/ai/master/handbook.ts` | **READ-ONLY** | Used only by baked path; vault path doesn't read it (the migration script does once, offline) |
| `src/ai/master/srd-context.ts` | **READ-ONLY** | SRD stays Postgres-resident for Phase 01 (see Section 3 SRD decision) |
| `src/ai/master/rag/*.ts` | **READ-ONLY** | Vault path never invokes `retrieveRelevant()` / `embed()`. RAG stays gated by `baked && useRagRetrieval` — unchanged |
| `src/ai/provider/local.ts` | **READ-ONLY** | The Ollama adapter is provider-agnostic re: tools — it accepts whatever tool list `runToolLoop` passes. No changes needed |
| `src/engine/tools/index.ts` | **READ-ONLY** | Engine tools (`set_current_player`, `cast_spell`, etc.) are NOT exposed on the vault path in Phase 01. Phase 02 adds `apply_event`. Phase 03 may unify |
| `src/db/schema/ai-usage.ts` | **READ-ONLY** | Telemetry continues firing; vault path calls `recordUsage()` exactly like baked path. The `ragChunkCount` field stays NULL for vault turns (semantic "not attempted") |
| `data/master_handbook.md` | **READ-ONLY** (migration source) | Migration script reads, splits by H2/H3, writes vault files. Original file kept on disk for the baked path |
| `data/master_world_lore.md` | **READ-ONLY** (migration source) | Same |
| `data/vault/` | **NEW** (greenfield) | Created by migration script. NOT committed wholesale to git in this phase — added to git only after first review (the structure will iterate) |
| `src/ai/master/vault/prompt-builder.ts` | **NEW** | Pure function from spike 012 |
| `src/ai/master/vault/prompt-builder.test.ts` | **NEW** | Vitest: forbidden-pattern lint + 1000-build SHA256 stability |
| `src/ai/master/vault/tools.ts` | **NEW** | The 4 Ollama tool definitions + handler implementations |
| `src/ai/master/vault/path.ts` | **NEW** | `safeVaultPath()`, `readVaultFile()`, `listVaultDir()` |
| `src/ai/master/vault/loop.ts` | **NEW** | Vault-specific tool-loop entry — calls provider, dispatches to vault tools, accepts both terminators |
| `scripts/migrate-handbook-to-vault.ts` | **NEW** | One-shot CLI (`pnpm migrate-handbook-to-vault`) that produces `data/vault/handbook/**` from the two source MDs |
| `scripts/build-rag-index.ts` | **READ-ONLY** | Unchanged — still drives the baked path |
| `vitest.config.ts` | **READ-ONLY** | Existing Vitest setup already picks up `*.test.ts` next to source — no config change needed |
| `package.json` | **MODIFY** | Add `"migrate-handbook-to-vault": "tsx scripts/migrate-handbook-to-vault.ts"` script |

## 2. Integration Plan

### Feature flag location

**Decision: per-campaign `settings.masterBackend`** (with env fallback), NOT per-user-prefs only and NOT per-request.

Rationale:
- `campaigns.settings` JSONB already holds analogous flags (`compactPrompt`, `useRagRetrieval`, `useModeAwarePrompt`). Mirror that pattern — zero schema migration needed, JSONB tolerates additive fields, and `getSessionMasterPreferences` already resolves campaign-level overrides.
- Per-request would be confusing: a single campaign mixing baked + vault turns would invalidate prefix cache constantly and make `ai_usage` data un-comparable.
- Env-level (`MASTER_BACKEND` env var) is the safety hatch for ops/CI overrides — resolved in `preferences.ts` as the last fallback before `'baked'`.

### Resolution order (in `preferences.ts`)
```
masterBackend = campaign.settings.masterBackend       // 1. campaign override
             ?? userPrefs.masterBackend               // 2. user default (added to UserPreferences)
             ?? (process.env.MASTER_BACKEND as Backend)  // 3. ops override
             ?? 'baked';                              // 4. project default — backwards-compatible
```

### Routing in `turn/route.ts`

Insert a branch right after `getSessionMasterPreferences()` returns and before the existing baked/srd/handbook block (~line 243). The branch decides the entire downstream path:

```
if (masterBackend === 'vault') {
  // Vault flow: build minimal system prompt, no SRD, no handbook,
  // no RAG, no meta-tools, 4 vault tools only. Snapshot is still
  // built (for ai_usage user_id + future apply_event payloads).
  const sys = buildVaultSystemPrompt({
    vaultRoot: 'data/vault',
    campaignId: campaign.id,
    toolCount: 3,  // Phase 01 ships 3 of the 4 (no apply_event yet)
  });
  const tools = vaultToolDefinitions();   // 4-tool array, never meta-tools
  await runVaultToolLoop({ provider, model: userPrefs.aiMasterModel, sys, history, tools, ... });
} else {
  // Existing baked + RAG + slim path — UNCHANGED.
}
```

### Coexistence with engine tools

Vault tools and engine tools (`set_current_player`, `cast_spell`, …) do NOT coexist in Phase 01. The vault path exposes ONLY the 4 vault tools per REQ-010. This is intentional — Phase 01's goal is "rules/lore questions via vault." Game-state mutations are Phase 02 (introduces `apply_event` and starts wiring engine ops through the vault path). When `masterBackend === 'vault'`, the runtime ignores the engine tools entirely; the player must not be on a vault-backed campaign and expect combat to work end-to-end yet.

**This is a deliberate scope cut, not a bug.** Document it in the phase plan: vault-backed campaigns in Phase 01 are read-only for game state. Players can ask "How does Fireball work at level 5?" and get a vault-backed answer. They cannot yet "cast fireball" through the vault path.

### Telemetry

`recordUsage()` is called identically — vault path passes `model: userPrefs.aiMasterModel`, `mode: undefined`, `needsSpellcasting: undefined`, `ragChunkCount: null`. The `prompt_eval_duration_ms`, `eval_duration_ms`, `load_duration_ms` flow through unchanged from the Ollama response. The M4 gate ("warm wall-clock < 10s") is verified by querying `ai_usage` for `endpoint='master'` rows with the vault model on M4-installed sessions.

## 3. Static Content Migration Design

### Source structure (verified by `grep -n "^##" data/master_*.md`)

- `master_handbook.md` (288 lines): 9 top-level H2 sections (Role / Knowing the Player / Pacing / Resolving Outcomes / Social / Exploration / Combat / Improvising / Death). H3 subsections (~50 of them, e.g. "### 4.1 When to Call for a Roll").
- `master_world_lore.md` (472 lines): 7 H2 sections (Multiverse / Magic / Deities / Cultures / Campaign Frames / Tropes / Rewards). H3 subsections.

These are NOT entity catalogs (spells, monsters, items) — they're prose DM craft and worldbuilding. Spike `001-vault-harness-bootstrap/vault/handbook/spells/fireball.md` shows the validated entity-catalog layout (frontmatter + body, ~20 lines per file).

### Canonical taxonomy

```
data/vault/handbook/
  craft/                    ← from master_handbook.md (DM craft, run-the-game)
    role.md                 ← H2 "1. Your Role" + its H3s collapsed
    knowing-the-player.md   ← H2 "2. Knowing the Player"
    pacing.md               ← H2 "3. Pacing & Narration"
    resolving-outcomes.md   ← H2 "4. Resolving Outcomes"
    social.md               ← H2 "5. Social Interaction"
    exploration.md          ← H2 "6. Exploration"
    combat.md               ← H2 "7. Combat"
    improvising.md          ← H2 "8. Improvising"
    death.md                ← H2 "9. Death and Consequences"
  lore/                     ← from master_world_lore.md (worldbuilding)
    cosmology.md            ← H2 "1. The Multiverse"
    magic.md                ← H2 "2. Magic in the World"
    deities.md              ← H2 "3. Deities and Religion"
    cultures.md             ← H2 "4. Cultures, Factions, Settlements"
    campaign-frames.md      ← H2 "5. Campaign Frames"
    tropes.md               ← H2 "6. Common Tropes and Hooks"
    rewards.md              ← H2 "7. Rewards and Gratification"
  spells/<id>.md            ← future (Phase 02 or later); not required for Phase 01
  monsters/<id>.md          ← future; not required for Phase 01
  items/<id>.md             ← future
  rules/<topic>.md          ← future (depends on SRD decision below)
  classes/<class>.md        ← future
  index.md                  ← TOC of the above; LLM reads on first turn (~300 tok)
```

**Why H2-level split, not H3-level:** spike findings show effective vault file size is 200-800 tokens. H3 sections in the handbook average 50-150 tokens — too granular, would create 50+ files for marginal benefit. H2 sections average 800-1500 tokens after stripping prose framing — within the sweet spot. The migration keeps H3 subheadings inside each H2 file as in-body markdown headings.

**Spells/monsters/items/rules/classes folders are scaffolded as empty in Phase 01**, with placeholder `.gitkeep` files. The actual SRD catalog migration is deferred (see SRD decision).

### SRD decision

**Recommendation: keep SRD in Postgres for Phase 01, do NOT migrate to vault yet.**

Reasoning:
- SRD is ~7K tokens (vs 25K handbook+lore), already accessible via `buildSrdContext()` which reads from `srdRuleDoc`, `srdClass`, `srdSpell`, etc.
- SRD is structured data (Drizzle schemas), not narrative prose. Converting to markdown is lossy and re-introduces work the database already does for free.
- Phase 01 success criterion ("Quanto danno fa Fireball al livello 5?") is a SPELL question — and spells are in `srdSpell` already. The vault path can either (a) skip SRD entirely and rely on the model's pretrained D&D knowledge for SRD content (qwen3-a3b validated 4/5 keyword on this), or (b) fetch spells from Postgres on demand via a new tool call. Option (a) is simpler and matches the spike findings (vault wins on quality without explicit SRD).
- Phase 03 explicitly reconsiders the SRD migration alongside the RAG decommission.

**Concrete implication for Phase 01:** `buildVaultSystemPrompt` does NOT inject SRD. If a question requires an SRD-specific number the model doesn't know (e.g. an obscure feat), the model falls back to general training. The benchmark scenario (Fireball damage) is well-known to qwen3-a3b — the spike's 4/5 keyword score confirms it.

### Migration script shape

One-shot, idempotent CLI:

```
scripts/migrate-handbook-to-vault.ts
  - Reads data/master_handbook.md → splits by /^## (\d+)\. (.+)$/ → writes data/vault/handbook/craft/<slug>.md
  - Reads data/master_world_lore.md → same → data/vault/handbook/lore/<slug>.md
  - Generates data/vault/handbook/index.md (table of contents with file paths)
  - Generates data/vault/tools/index.md (4-tool description) + per-tool .md stubs
  - Idempotent: overwrites existing files (regeneration after source edits is the workflow)
```

Run once via `pnpm migrate-handbook-to-vault`. The generated `data/vault/` is committed to git (it IS the source of truth at runtime — the source MDs become an authoring convenience only).

## 4. Tool Surface Integration

The 4 vault tools (REQ-010) do NOT belong in `src/engine/tools/index.ts` because:
- Engine tools are typed against `ActionResult { mutations, rolls, data }` shape — vault tools return raw strings (file content) or error markers.
- Engine handlers run synchronously against `EngineState`; vault tools do async filesystem I/O.
- Mixing them invites the model to call `cast_spell` on the vault path (where it's not wired) — Phase 01 wants strict separation.

**Location: new module `src/ai/master/vault/tools.ts`** that owns:

```
export const VAULT_TOOL_DEFINITIONS: OllamaTool[] = [
  { name: 'read_vault_multi', ... },   // array-of-paths schema, NO singular variant
  { name: 'list_vault', ... },
  { name: 'end_turn', ... },
  // 'apply_event' is Phase 02 — NOT shipped in Phase 01
];

export async function dispatchVaultTool(
  name: string,
  input: unknown,
  ctx: { vaultRoot: string }
): Promise<{ content: string; isError: boolean }> { ... }
```

The tool definitions follow the exact shape validated by spike 009 (`sources/009-read-vault-multi/run-multi.ts`) — `tools: [{ type: 'function', function: { name, description, parameters } }]` for Ollama, with the `read_vault_multi` description explicitly saying "Read MANY files in ONE call" to prevent the model from emitting multiple `read_vault_multi({paths:[X]})` calls in sequence (which the spike data shows is a regression to the sequential pattern).

**Why a new loop, not `runToolLoop`:** `runToolLoop` (`src/ai/master/tool-loop.ts`) is tightly coupled to the engine — it imports `TOOL_HANDLERS`, `TOOL_HANDLERS_DB`, `dispatchMetaCall`, and `applyMutations`. Forcing the vault path through it requires either (a) passing all those as nullable injections, (b) adding a "no-mutations" branch, or (c) duplicating it. **Recommendation: option (c) — `runVaultToolLoop` in `src/ai/master/vault/loop.ts`.** It will be ~80 LOC (versus tool-loop.ts's ~330 LOC) because it drops the meta-dispatch, required-tools-before-end, persistence, state_changed events, and tentative buffering. It reuses the provider's `completeMessage` and the same `TurnEvent` types.

This duplication is intentional and aligns with the "behind a feature flag — baked path untouched" goal. Phase 03 (when baked is retired) can unify them.

## 5. Prompt Builder Design

**Location: `src/ai/master/vault/prompt-builder.ts`** — sibling to the engine-coupled `system-prompt.ts`, NOT a replacement.

**Signature (matches spike 012 verbatim):**

```ts
export interface VaultPromptInput {
  vaultRoot: string;       // 'data/vault'
  campaignId: string;      // campaign UUID
  toolCount: number;       // 3 in Phase 01, 4 after Phase 02 adds apply_event
  language?: string;       // optional — campaign language hint
}
export function buildVaultSystemPrompt(input: VaultPromptInput): string;
export function hashVaultPrompt(prompt: string): string;
```

The output is the literal template from `references/prompt-builder.md` adapted to dnd-ai-master:
- Role line ("You are an experienced D&D 5e Dungeon Master.")
- Knowledge layout (vault root + path schema)
- Tool usage protocol (lenient — read `/tools/index.md` once)
- Active campaign pointer (`/campaigns/<id>/` — even though Phase 01 doesn't yet have campaign dirs, the path is reserved for Phase 02)
- Language mirroring line (if `input.language` set)
- "Keep responses concise"

**Does NOT include:** SRD context, handbook, world lore, meta-tools instruction, rewards mandate, scene card, codex index, ROLL_TRIGGERS, MANUAL_ROLLS_RULE, party mode, tonal frame, engagement profile. All of those are baked-path concerns.

**How it differs by `masterBackend`:**
- `'baked'` → existing `buildMasterSystemPrompt` runs (unchanged)
- `'vault'` → `buildVaultSystemPrompt` runs (new, pure, small)

They're parallel functions with NO shared inputs object. The vault path does not consume `manualRolls`, `narrationPace`, `chapterDigests`, etc. in Phase 01 — those become available again in Phase 03 when the vault path matures.

**Interaction with `slim-prompts.ts`:** none. `slim-prompts.ts` is loaded only by the baked Modelfile builder (`scripts/build-local-models.ts`), which never runs in the vault path. They're independent code paths.

## 6. CI Test Strategy

**Framework: Vitest** (verified — `package.json` declares `"test": "vitest run"`, `vitest.config.ts` exists). Test files live next to source as `*.test.ts`. No new infrastructure needed.

**Tests to ship in Phase 01:**

| Test file | Type | What it asserts |
|---|---|---|
| `src/ai/master/vault/prompt-builder.test.ts` | Unit | (1) 1000 builds with same input → 1 unique SHA256 (spike 012). (2) Forbidden-pattern lint: builder source contains no `Date.now(`, `new Date(`, `Math.random(`, `process.hrtime`, `randomUUID(`, `process.env.`, `.hostname(`. (3) Different inputs produce different hashes. |
| `src/ai/master/vault/path.test.ts` | Unit | `safeVaultPath()` rejects `../`, absolute paths outside vault, null bytes, symlink escape; accepts well-formed paths. |
| `src/ai/master/vault/tools.test.ts` | Unit | `read_vault_multi` returns concatenated `### {path}\n\n{content}\n\n---` blocks; `list_vault` returns immediate children only; `end_turn` echoes `response`; invalid paths surface as `ERROR: path outside vault`. |
| `src/ai/master/vault/loop.integration.test.ts` | Integration | Mocks the provider with a scripted tool-call sequence; asserts the loop accepts both terminators (`end_turn` tool call AND `no_tool_calls + content`) per REQ-013. |
| `scripts/migrate-handbook-to-vault.test.ts` | Unit | Migration produces expected file count, expected categories, expected frontmatter shape; idempotent re-run yields byte-identical output. |

**Forbidden-pattern lint caveat (from `prompt-builder.md`):** the regex source-scan trick produces a false positive when `FORBIDDEN` is defined inline in the same test file (the regex matches its own string literal). Workaround: move the `FORBIDDEN` array to a separate `src/ai/master/vault/__forbidden-patterns.ts` (not under scan) OR use an AST-based ESLint custom rule. **Recommendation: separate file** — fastest, no toolchain change. The planner should treat the AST/ESLint route as out of scope for Phase 01.

**M4 benchmark gate ("warm wall-clock < 10s"):** there is currently no E2E test framework in the repo (`find src -name '*.test.ts'` near master returns nothing — only Vitest unit tests exist). The phase success criterion specifies "measured via existing telemetry" — which means querying `ai_usage` rows after running the vault path manually on M4. **Recommendation: do NOT add a CI gate for M4 wall-clock in Phase 01.** Instead, ship a `scripts/bench-vault-m4.ts` runner (similar to `sources/004-m4-validation/`) that hits the integrated Next.js endpoint and reports prompt_eval_duration_ms / eval_duration_ms from `ai_usage`. The dev runs it manually post-deploy on the M4. CI on the M5 dev machine cannot validate the M4 gate honestly — bandwidth ratio breaks the prediction for MoE models.

## 7. Open Questions for the Planner

1. **Campaign-level vault dir.** REQ-003 says "Dynamic knowledge entry point: `/campaigns/<campaign-id>/index.md`". Phase 01 is read-only (no game-state writes — Phase 02 owns those). Should the vault path attempt to read `/campaigns/<id>/index.md` (if it exists) on every turn, OR should Phase 01 explicitly NOT touch campaign dirs and only serve handbook/lore? **Researcher leans: skip campaign dirs in Phase 01** — they don't exist until Phase 02 creates them. The system prompt mentions the path as future-reserved but `read_vault_multi` returns "file not found" gracefully if the model asks.
2. **User-prefs vs campaign-only flag.** Should `masterBackend` ALSO be a user preference (in `src/db/schema/users.ts`), or campaign-settings-only? Researcher leans campaign-only for Phase 01 — easier rollback, scopes the experiment tightly. Add to user prefs in Phase 03.
3. **Vault root location.** `data/vault/` vs `vault/` (top-level) vs `src/vault/`? `data/vault/` is consistent with `data/master_handbook.md` (current content lives in `data/`). Researcher recommends `data/vault/`. The planner should confirm — moving later is a non-trivial git history mess.
4. **Migration script: progressive or one-shot?** Researcher recommends one-shot (idempotent, ~5 minutes to write, immediate full vault). Progressive (lazy-split on first access) adds complexity for no benefit at this scale (~15 generated files total).
5. **`thinking` flag handling on vault path.** `thinkingFlagFor('qwen3:30b-a3b-instruct-2507-q4_K_M')` returns `undefined` (correctly — instruct variant has no thinking head). The vault path inherits this for free via the local provider. But: does the vault path need its own override path for `thinking_enabled` signaling to `SystemPromptBuilder`? Researcher: no — `buildVaultSystemPrompt` does not have a `thinkingEnabled` input. Confirm acceptable.
6. **`OLLAMA_NUM_CTX`.** Existing default is 65536 (set in `src/ai/provider/local.ts:33`). Vault path with ~3K system prompt + small history easily fits — no change needed. Planner: do not bump or shrink in Phase 01.
7. **Where does the M4 bench runner live?** `scripts/bench-vault-m4.ts` is researcher's recommendation, mirroring `scripts/build-local-models.ts` location. Alternative: `tests/manual/bench-vault-m4.ts`. Planner picks.
8. **History format on vault path.** The existing baked path uses budget-aware history truncation (`MASTER_PROMPT_BUDGET` env, default 12500). Vault path has a much smaller fixed system prompt (~3K vs ~10K baked), so the budget calculation is too conservative. Researcher: ship Phase 01 with the existing budget code reused but flag a follow-up to retune the constants in Phase 02 when typical vault session profiles are known.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Adding `masterBackend?: string` to `CampaignSettings` requires no DB migration because the column is JSONB | §1, §2 | LOW — verified by reading `campaigns.ts` lines 65 (`settings: jsonb('settings').notNull().default(sql\`'{}'::jsonb\`)`) — JSONB is schemaless; additive fields are safe |
| A2 | qwen3:30b-a3b-instruct-2507-q4_K_M model has pretrained knowledge of Fireball-at-level-5 damage sufficient to pass the Phase 01 success criterion without an SRD block in the prompt | §3 (SRD decision) | MEDIUM — spike 004 measured 4/5 keyword on Fireball-class questions on M4 with this model. Not 5/5. If the planner wants 5/5 guaranteed, ship a tiny `spells/fireball.md` vault file as part of migration and add Fireball to the bench. |
| A3 | `runToolLoop` is too tightly coupled to the engine to reuse on the vault path; a parallel `runVaultToolLoop` is simpler | §4 | LOW — verified by reading `src/ai/master/tool-loop.ts` lines 1-5 (engine imports) and the meta-dispatch / required-tools-before-end / persistence layers in lines 88-323 |
| A4 | SRD does not need to be in the vault for Phase 01 (deferred to Phase 03) | §3 | MEDIUM — depends on A2. If A2 wrong, SRD-as-vault becomes a Phase 01 add (still scope-appropriate). |
| A5 | The vault path will not attempt to call any engine tool (cast_spell, set_current_player, etc.) in Phase 01 | §2 | LOW — researcher's design choice. The vault tool registry never contains engine tools; the Ollama model only "knows about" the 3 tools listed in the system prompt + tool definitions. |
| A6 | One-shot migration script is acceptable because `data/vault/` is small (~15 files) | §3 | LOW — file count verified by H2 counts (9 + 7 = 16 craft+lore files) |
| A7 | Vitest existing config picks up new `*.test.ts` files under `src/ai/master/vault/` without config changes | §6 | LOW — verified by `package.json` (`"test": "vitest run"`) and existing pattern in repo |
| A8 | M4 wall-clock gate cannot be validated in CI (CI runs on dev hardware, not target hardware) | §6 | LOW — design decision aligned with `performance.md` § "Always measure on production hardware" |

## Sources

### Primary (HIGH confidence)
- Skill `spike-findings-dnd-ai-master` (auto-loaded): `SKILL.md`, `references/storage-and-mutation.md`, `tool-surface.md`, `performance.md`, `model-selection.md`, `prompt-builder.md`
- Skill `sources/`: `001-vault-harness-bootstrap/vault/**` (canonical layout), `009-read-vault-multi/run-multi.ts` (validated tool schema), `012-prompt-builder-stability/{builder,test}.ts` (pure-function pattern)
- `.planning/REQUIREMENTS.md` REQ-001..REQ-034 (LOCKED)
- `.planning/ROADMAP.md` Phase 01 scope
- `docs/superpowers/specs/2026-05-22-vault-llm-wiki-{design,risks}.md`
- `src/db/schema/campaigns.ts` (settings JSONB shape)
- `src/lib/preferences.ts` (resolution pattern for `compactPrompt`, `useRagRetrieval`)
- `src/app/api/sessions/[id]/turn/route.ts` (branch insertion point)
- `src/ai/master/tool-loop.ts` (loop architecture)
- `src/ai/master/baked-models.ts` (`thinkingFlagFor`, baked detection)
- `src/db/schema/ai-usage.ts` (telemetry continuity)

### Secondary (MEDIUM confidence)
- AGENTS.md (Next.js-is-not-what-you-know caveat — informs the "use existing patterns" stance)
- `data/master_handbook.md` + `data/master_world_lore.md` H2 enumeration (taxonomy basis)

## Metadata

**Confidence breakdown:**
- Code-touch map: HIGH — every file read directly
- Integration plan (flag location, routing): HIGH — mirrors existing `compactPrompt` / `useRagRetrieval` pattern verified in `preferences.ts`
- Migration taxonomy: HIGH — H2 enumeration grep verified; canonical layout from spike sources
- Tool surface module placement: MEDIUM — design choice (separate from engine tools), not validated end-to-end yet
- Prompt builder design: HIGH — direct lift from spike 012 verified pattern
- CI tests: HIGH — Vitest infra already exists; patterns lifted from spike 012
- Open questions: HONEST — researcher flagged decisions the planner must make

**Research date:** 2026-05-24
**Valid until:** 2026-06-23 (30 days — codebase moves slowly; spikes are locked)
