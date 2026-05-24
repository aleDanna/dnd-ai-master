# Phase 01 Summary: Vault Read Path

**Status:** Shipped (all 9 plans landed, all tests green).
**Date range:** 2026-05-24
**Commits:** `402327e` (plan 01) → `57539b9` (plan 08), `f4f0fd7`, `5b605c5`, `68a2b59`, `16de8d8`, `6014209`.

## What shipped

- **Plan 01** — `safeVaultPath` + `readVaultFile` + `listVaultDir` primitives + `VAULT_ROOT` constant. ([plan](./plans/01-vault-path-safety.md))
- **Plan 02** — `buildVaultSystemPrompt` pure-function builder + `hashVaultPrompt` + ESLint-style forbidden-pattern lint. ([plan](./plans/02-vault-prompt-builder.md))
- **Plan 03** — `VAULT_TOOL_DEFINITIONS` (3 tools: `read_vault_multi`, `list_vault`, `end_turn`) + `dispatchVaultTool` + `formatMultiReadResult`. ([plan](./plans/03-vault-tool-definitions.md))
- **Plan 04** — `runVaultToolLoop` — parallel-to-`runToolLoop` orchestrator with dual-terminator handling (REQ-013). ([plan](./plans/04-vault-tool-loop.md))
- **Plan 05** — `scripts/migrate-handbook-to-vault.ts` — idempotent CLI that splits handbook + lore into per-H2 vault files (12 craft + 8 lore = 20 files) + scaffolds the future-category placeholders. ([plan](./plans/05-migration-script.md))
- **Plan 06** — `masterBackend` flag on `CampaignSettings` + parallel-shape on `UserPreferences` + resolver chain (campaign → env → 'baked'). ([plan](./plans/06-campaign-settings-flag.md))
- **Plan 07** — Vault branch wired into `src/app/api/sessions/[id]/turn/route.ts` behind the flag. Baked path untouched. ([plan](./plans/07-turn-route-branch.md))
- **Plan 08** — `scripts/bench-vault-m4.ts` — manual M4 benchmark runner (NOT CI gate). ([plan](./plans/08-m4-bench-runner.md))
- **Plan 09** — this summary + operator guide + barrel-import smoke test.

## REQ traceability matrix

| REQ | Statement | Implementation | Test |
|---|---|---|---|
| REQ-001 | Vault is filesystem-only markdown | `data/vault/` populated by `scripts/migrate-handbook-to-vault.ts` | `tests/scripts/migrate-handbook-to-vault.test.ts` |
| REQ-002 | Static knowledge path-deterministic `/handbook/<category>/<id>.md` | Migration script + scaffolded `{spells,monsters,items,rules,classes}/` dirs | `tests/scripts/migrate-handbook-to-vault.test.ts` |
| REQ-010 | 4-tool surface (3 of 4 in Phase 01; `apply_event` is Phase 02) | `src/ai/master/vault/tools.ts` | `tests/ai/master/vault/tools.test.ts` |
| REQ-011 | NEVER expose singular `read_vault` — only batched `read_vault_multi` | `tools.ts` definitions + grep gate | `tests/ai/master/vault/tools.test.ts`, `phase-smoke.test.ts` |
| REQ-012 | Lenient discovery `/tools/index.md` | Migration generates `tools/index.md` + prompt mentions it | `tests/scripts/migrate-handbook-to-vault.test.ts`, `prompt-builder.test.ts` |
| REQ-013 | Server accepts both terminators (`end_turn` AND `no_tool_calls + content`) | `src/ai/master/vault/loop.ts` dual-terminator branches | `tests/ai/master/vault/loop.test.ts` (terminator 1 + 2 cases) |
| REQ-014 | `safeVaultPath()` on every vault read | `src/ai/master/vault/path.ts` | `tests/ai/master/vault/path.test.ts` |
| REQ-021 | Warm wall-clock < 10s on M4 | Full stack — measured manually with `pnpm bench-vault-m4` | Manual (NOT CI — REQ-020 requires production hardware) |
| REQ-022 | Pure-function prompt builder + lint enforcing prefix-cache hygiene | `src/ai/master/vault/prompt-builder.ts` + sibling `__forbidden-patterns.ts` | `tests/ai/master/vault/prompt-builder.test.ts` (1000-build SHA stability + source-scan lint) |
| REQ-030 | Primary local model `qwen3:30b-a3b-instruct-2507-q4_K_M` base slug | Vault branch in `turn/route.ts` passes `userPrefs.aiMasterModel` through unchanged; no `isBakedModel()` rewrite on vault path | `tests/sessions/turn-route-branch.test.ts` |
| REQ-033 | Drop baked dependency for vault-flagged campaigns | Vault branch never calls `buildSrdContext` / `getMasterHandbook` / `getMasterWorldLore` / `retrieveRelevant` / `warnIfBakedModelStale` | `tests/sessions/turn-route-branch.test.ts` (system prompt content check) |

11/11 REQs covered. Run `pnpm test` for the full vault test suite (104+ cases across 6 files).

## What this phase did NOT deliver (and why)

- **`apply_event` tool / mutation surface.** Vault campaigns are READ-ONLY for game state in Phase 01. Adding mutation requires the events.md single-writer queue (validated by spike 010) but that's owned by Phase 02. Documented in the system prompt: `/campaigns/<id>/` is "reserved — populated in a later release".
- **UI toggle for `masterBackend`.** The flag is backend-only — settable via `PUT /api/campaigns/[id]/settings`. Phase 02 may layer a Settings UI control.
- **RAG decommission + baked-variant retirement.** Both stay running in parallel for Phase 01 (coexistence). Phase 03 retires them once vault parity is proven.
- **Per-turn summarization at the 15K-token boundary** (spike 011 finding). Not needed in Phase 01 because vault prompts are already small; needed in Phase 02 when `apply_event` adds growing event history.
- **History budget retune** for the smaller vault prompt envelope. Phase 01 reuses existing `MASTER_PROMPT_BUDGET` (12500) + `MASTER_HISTORY_LIMIT` (10). Phase 02 may retune once typical vault session profiles are known.

## Known limits / follow-ups

- **Phase 02 must add `apply_event`** to the vault tool surface — closes REQ-010's 4th tool. The events.md write path is already validated by spike 010 (`EventsWriter` mutex pattern).
- **Phase 02 must respect REQ-007 (campaign data OUT of codebase repo).** A new constant `VAULT_CAMPAIGNS_ROOT` resolves an env-configurable path defaulting to `~/.dnd-ai-master/vault/campaigns/`. The static `VAULT_ROOT` (`data/vault/`) stays unchanged. Phase 02 planner picks the backup strategy: tarball+cron / separate git repo / S3 sync.
- **Phase 02 may add a campaign-settings UI toggle** for `masterBackend` (Phase 01 ships backend-only).
- **Phase 03 retires the RAG stack** (`src/ai/master/rag/*`, `scripts/build-rag-index.ts`, pgvector extension) + baked variants other than `dnd-master-plus` (regression-test baseline) once vault parity is confirmed.
- **Vitest test-discovery scope:** vitest scans ONLY `tests/**/*.test.{ts,tsx}` (see `vitest.config.ts:31-40`). Colocated `src/**/*.test.ts` files are NOT picked up. All Phase 01 tests live under `tests/<area>/`. RESEARCH.md §6+§A7 incorrectly claimed colocated tests work — discovered during plan-check; SUMMARY records it so the Phase 02 planner does not re-trip.
- **Bench `--bypass-http` mode** (skip the route, call `runVaultToolLoop` directly) — not implemented in Phase 01 because REQ-021 requires integrated-route latency. Acceptable Phase 02 polish for quick smoke iteration.
- **Vault branch finalize logic is duplicated from the baked path** (not extracted to a helper) — minimizes Phase 01 risk surface. Phase 02 may refactor with event-sourcing semantics.
- **DATABASE_URL is required at test time** for any test that imports `@/lib/preferences` (pre-existing project convention; not specific to Phase 01).

## Performance baseline

| Metric | Baseline (baked, `dnd-master-plus`) | Phase 01 (vault, `qwen3:30b-a3b-instruct-2507-q4_K_M`) |
|---|---|---|
| Warm wall-clock (M4) | 26.05s (spike 004) | **TBD — run `pnpm bench-vault-m4` on M4 and fill in** |
| `prompt_eval_count` | ~8800 | **TBD by bench** |
| `rag_chunk_count` | 0-3 | NULL (RAG not attempted on vault path) |
| Quality (5-keyword check) | 4/5 (spike 004) | **TBD** (expected ≥4/5 per spike 014 narrative validation) |

When the developer fills the TBD column on M4, the REQ-021 gate verdict is established.

## Test totals (Phase 01 cumulative)

| Plan | Test file | Cases |
|---|---|---|
| 01 | `tests/ai/master/vault/path.test.ts` | 23 |
| 02 | `tests/ai/master/vault/prompt-builder.test.ts` | 13 |
| 03 | `tests/ai/master/vault/tools.test.ts` | 21 |
| 04 | `tests/ai/master/vault/loop.test.ts` | 11 |
| 05 | `tests/scripts/migrate-handbook-to-vault.test.ts` | 15 |
| 06 | `tests/lib/preferences-master-backend.test.ts` | 22 |
| 07 | `tests/sessions/turn-route-branch.test.ts` | 14 |
| 08 | (no test — manual bench) | n/a |
| 09 | `tests/ai/master/vault/phase-smoke.test.ts` | 4 |
| **Total** | **8 test files** | **123 cases** |

All passing as of phase close.
