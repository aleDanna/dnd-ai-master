# Phase 01: Vault Read Path

**Goal:** The LLM master can answer rules/lore questions using ONLY the markdown vault for static knowledge, with no RAG retrieval and no `MASTER_TOOL_CONTRACT` injection. Behind a feature flag — the existing baked-variant + RAG path is untouched.

**Status:** Planned, ready for execution
**Estimated total scope:** ~2200 lines across 9 plan files (code + tests + content + scripts)
**Plan budget:** ~1500 LOC source + ~450 LOC tests + ~250 LOC scripts/migration glue

---

## Decisions made by this plan (the 6 open questions)

1. **Campaign-level vault directory in Phase 01:** **NO — skipped.**
   Phase 01 is read-only static content. No per-campaign vault dirs exist yet (Phase 02 owns campaign mutations + `apply_event`). The system prompt mentions the path `/campaigns/<id>/` as future-reserved; `read_vault_multi` returns "ERROR: file not found at <path>" gracefully if the model asks. This keeps Phase 01 free of any state-mutation surface.

2. **`masterBackend` flag location:** **Campaign-settings only.** Stored on `campaigns.settings.masterBackend: 'vault' | 'baked'`. NOT mirrored to `users.preferences.masterBackend` (would complicate per-campaign rollback). Env fallback via `MASTER_BACKEND` for ops/CI override. Mirrors the existing `compactPrompt` / `useRagRetrieval` pattern verbatim — settable via the existing `PUT /api/campaigns/[id]/settings` route through a single-line additive change to the allowlist.

3. **Vault root path:** **`data/vault/`.** Sibling of existing `data/master_handbook.md` and `data/master_world_lore.md` — same semantic neighbourhood (static content the app ships). `vault/` at repo top would split content from `data/`; `src/vault/` would mix code and content. Path is centralised in one constant (`VAULT_ROOT` in `src/ai/master/vault/path.ts`) so a future relocation is a one-line change.

4. **Migration approach:** **One-shot, idempotent CLI** (`scripts/migrate-handbook-to-vault.ts`). Reasoning: only ~16 generated files (9 craft + 7 lore + index.md + tools/*.md). Progressive (lazy-split on first access) adds runtime branching for zero benefit at this scale. Idempotent re-run yields byte-identical output (verified by test). The generated `data/vault/` IS committed to git — it becomes the runtime source of truth; `data/master_*.md` becomes the authoring convenience for regeneration.

5. **Bench runner location:** **`scripts/bench-vault-m4.ts`.** Consistent with existing `scripts/build-rag-index.ts`, `scripts/db-audit.ts`. `pnpm bench-vault-m4` script wired in `package.json`. NOT a CI gate — the dev runs it manually on the M4 box and inspects `ai_usage` query output. CI on the M5 Pro dev hardware cannot validate the M4 wall-clock target honestly (M4 = production target per REQ-020).

6. **History budget retune:** **Follow-up, deferred to Phase 02.** Phase 01 reuses the existing `MASTER_PROMPT_BUDGET` (12,500 tok) + `MASTER_HISTORY_LIMIT` (10) for the vault path unchanged. Spike 011 showed summarization is needed at the 15K-token boundary, but that's a mid-session bottleneck (REQ-023) outside the read-only first phase. The vault system prompt is ~3K tok (vs ~10K baked), so the existing budget is conservative-but-safe for Phase 01. Phase 02 retunes once typical vault session profiles are measured.

---

## Plan execution order

The plans split along dependency lines: foundation primitives (path safety, prompt builder, tool defs) first, then composition (loop, route branch), then content (migration), then verification (tests, bench, docs).

| Order | Plan | Depends on | Net diff |
|---|---|---|---|
| 1 | `plans/01-vault-path-safety.md` | none | ~120 LOC + 80 LOC tests |
| 2 | `plans/02-vault-prompt-builder.md` | 01 | ~80 LOC + 100 LOC tests |
| 3 | `plans/03-vault-tool-definitions.md` | 01 | ~150 LOC + 90 LOC tests |
| 4 | `plans/04-vault-tool-loop.md` | 03 | ~250 LOC + 150 LOC tests |
| 5 | `plans/05-migration-script.md` | 01 | ~280 LOC + 90 LOC tests |
| 6 | `plans/06-campaign-settings-flag.md` | none (data layer only) | ~70 LOC + 60 LOC tests |
| 7 | `plans/07-turn-route-branch.md` | 02, 04, 06 | ~120 LOC + 80 LOC tests |
| 8 | `plans/08-m4-bench-runner.md` | 07 (functionally; can be authored in parallel) | ~200 LOC |
| 9 | `plans/09-rollout-and-docs.md` | all | ~120 LOC (docs + REQ traceability) |

**Parallelism observation:** plans 01, 06 are independent foundation work. Plans 02, 03, 05 depend only on 01. Plans 04 depends on 03. Plan 07 is the integration step that ties 02 + 04 + 06 together. Plan 08 is bench-only (no integration); can land after 07. Plan 09 is the wrap-up.

The numbering above reflects atomic-commit order — each plan = one reviewable PR-shaped commit.

---

## Phase-level success criteria (from ROADMAP)

- ✓ A turn that asks **"Quanto danno fa Fireball al livello 5?"** works end-to-end via vault path
- ✓ `prompt_eval_count` per turn drops from ~8,800 (baked) to ~3,000-5,000 (vault) — measured in `ai_usage`
- ✓ Warm wall-clock turn < 10s on M4 (measured via existing telemetry, NOT a CI gate)
- ✓ Feature flag toggle works in both directions (baked ↔ vault) per campaign (NOT per request — see Decision 2)
- ✓ All existing E2E + unit tests pass with `MASTER_BACKEND=baked` (default; no behavioural change for non-opted-in campaigns)
- ✓ New unit + integration tests cover `MASTER_BACKEND=vault` happy path

**Scope cut documented in plan 06:** Vault-backed campaigns in Phase 01 are **read-only for game state**. The vault tool surface exposes only `read_vault_multi`, `list_vault`, `end_turn` — NO `apply_event`, NO engine tools (`cast_spell`, `set_current_player`, etc.). Players can ask "How does Fireball work at level 5?" via the vault path; they CANNOT mutate game state through it yet (Phase 02 adds `apply_event` and re-introduces state mutation). The campaign-settings flag UI MUST surface this limitation (deferred to plan 09; backend-only flag in Phase 01).

---

## How to validate phase completion

Run, in order:

1. **Unit + integration tests pass:**
   ```
   pnpm test
   ```
   All existing tests untouched. New tests cover: path safety, prompt builder stability, vault tool dispatch, vault loop terminator handling, migration idempotency, settings-flag validation, route-branch selection.

2. **Migration produces the expected vault layout:**
   ```
   pnpm migrate-handbook-to-vault
   ls data/vault/handbook/craft/   # 9 files: role.md, knowing-the-player.md, ...
   ls data/vault/handbook/lore/    # 7 files: cosmology.md, magic.md, ...
   ls data/vault/tools/            # index.md + 3 tool stubs
   ```

3. **Type + lint clean:**
   ```
   pnpm typecheck
   pnpm lint
   ```

4. **Bench on M4 (manual, not CI):**
   ```
   pnpm bench-vault-m4
   ```
   Inspect output: warm wall-clock < 10s, `prompt_eval_count` ~3-5K. Cross-check by querying `ai_usage` rows tagged with the run timestamp.

5. **Live smoke test on a vault-flagged campaign:**
   - Set `campaigns.settings.masterBackend = 'vault'` for a test campaign (via PUT /api/campaigns/:id/settings or direct DB update on the dev box)
   - Send the turn "Quanto danno fa Fireball al livello 5?"
   - Confirm the response cites Fireball mechanics correctly
   - Confirm `ai_usage` row for that turn shows the lowered `prompt_eval_count`
   - Flip the flag back to `'baked'`; confirm the baked path still works on the same campaign

---

## What this phase explicitly does NOT do

These are bounded by Phase 01's read-only scope:

- ❌ **No `apply_event` tool.** Phase 02 adds it. The vault path in Phase 01 has 3 tools, not 4.
- ❌ **No campaign-level vault directory.** No `/campaigns/<id>/index.md`, no per-campaign events.md. Phase 02 owns those.
- ❌ **No engine-tool exposure on the vault path.** `set_current_player`, `cast_spell`, etc. are NOT in the vault tool surface. The vault path cannot mutate game state.
- ❌ **No RAG retirement.** The RAG stack (`src/ai/master/rag/`) remains in place, gated by `baked && useRagRetrieval`. Phase 03 retires it.
- ❌ **No baked-variant retirement.** All `dnd-master-*` variants remain installable. Phase 03 drops them.
- ❌ **No SRD migration.** SRD (`buildSrdContext`) stays Postgres-resident, only consumed by the baked path. The vault path does NOT inject SRD — it relies on the model's pretrained D&D knowledge (qwen3-a3b's 4/5 keyword score on Fireball validated this).
- ❌ **No history budget retune.** Existing `MASTER_PROMPT_BUDGET`/`MASTER_HISTORY_LIMIT` reused unchanged (Phase 02 follow-up).
- ❌ **No settings UI toggle for `masterBackend`.** Backend-only flag (set via API PUT or direct DB update). Phase 02 may add the UI.
- ❌ **No per-turn summarization.** REQ-023 is Phase 03 deliverable.
- ❌ **No multi-process EventsWriter.** NON-REQ-001 — single-Next.js-server invariant.
- ❌ **No "Keep responses concise" in the vault system prompt builder beyond what spike 014 validated.** The validated builder template (from `references/prompt-builder.md`) is the reference, NOT the existing slim/full variants.

---

## Cross-references

- **Requirements satisfied by this phase:** REQ-001, REQ-002, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-021, REQ-022, REQ-030, REQ-033 (`.planning/REQUIREMENTS.md`).
- **Research input:** `RESEARCH.md` (this directory) — code-touch map, integration plan, taxonomy, open questions.
- **Spike findings:** `.claude/skills/spike-findings-dnd-ai-master/` — implementation patterns (auto-loadable).
- **Design specs:** `docs/superpowers/specs/2026-05-22-vault-llm-wiki-{design,risks}.md`.
- **Existing patterns mirrored:** `src/lib/preferences.ts` (settings resolution), `src/db/schema/campaigns.ts:65` (JSONB settings), `src/app/api/sessions/[id]/turn/route.ts:243-507` (branch insertion point).
