---
name: spike-findings-dnd-ai-master
description: Implementation blueprint from 14 spike experiments for the vault-llm-wiki migration. Validated patterns for vault storage, mutation safety, LLM tool surface, M4 performance targets, model selection, and stable prompt building. Auto-loaded during implementation work.
---

<context>
## Project: dnd-ai-master

Validated migration design for replacing the current RAG-based knowledge layer (Postgres + pgvector + Ollama embedder) and dynamic state layer (Postgres + drizzle) with a **filesystem-only markdown vault** navigated by the LLM via tool calls. Production target: **Mac Mini M4** (32GB RAM, 120 GB/s bandwidth, 256GB SSD).

Spike sessions wrapped: 2026-05-22 through 2026-05-24 (3 rounds + narrative iteration, 14 spikes).
</context>

<requirements>
## Requirements (non-negotiable)

These emerged from spike work and lock the design. Every implementation choice must honor them.

### Storage & mutation

- **Vault = filesystem markdown only.** Obsidian-app optional. No knowledge DB.
- **Static knowledge = path-deterministic.** `/handbook/<category>/<id>.md`.
- **Dynamic knowledge = wiki-link traversal.** Entered via `/campaigns/<id>/index.md`.
- **events.md is the source of truth.** Derived view files are projections regeneratable from event replay.
- **Mutations via `EventsWriter` single-writer mutex.** NEVER naive read-modify-write — spike 006 measured 99% loss rate.
- **DR strategy:** git the vault + replay events.md. No `pg_dump`. Validated byte-exact restore (spike 013).

### LLM tool surface

- **Fixed 4-tool surface:** `read_vault_multi`, `list_vault`, `apply_event`, `end_turn`.
- **NEVER expose singular `read_vault(path)`.** Sequential is -59.7% slower with worse quality (spike 009).
- **Lenient discovery protocol:** read `/tools/index.md` once at session start, then use tools directly.
- **Accept BOTH turn terminators:** `end_turn` tool call AND `no_tool_calls + content` are valid.
- **Path sanitization mandatory** on every vault read (`safeVaultPath()`).

### Performance & prompt

- **Target wall-clock M4 warm:** < 10s for typical turn (validated at 3.78s on chosen primary).
- **Prefix-cache hygiene mandatory.** `SystemPromptBuilder` must be pure function. ESLint rule + CI test enforce no `Date.now`, `Math.random`, `process.env`, etc.
- **Per-turn summarization at 15K-token boundary** (Phase 1 deliverable, not yet built).

### Model selection (M4 production)

- **Primary:** `qwen3:30b-a3b-instruct-2507-q4_K_M`. G1 -85.5% warm, G2 100% lenient, narrative 9 pts.
- **Quality-fallback (opt-in):** `qwen3:30b-a3b-instruct-2507`. Within 2.4% of primary, marginally better NPC voicing.
- **Offline content tool (non-default):** `mistral-small3.2:24b`. For voice-strong non-standard prose (goblin pidgin, draconic).
- **Eliminated entirely:** `qwen3:30b-a3b` BASE (CoT leak), `llama3.2:3b` (0% compliance), mistral q4 variant (G1 regression).
- **No tier-split router in Phase 1.** Δ primary-vs-fallback too small.
- **Drop all `dnd-master-*` baked variants in production.** Frees ~50GB SSD.

### Hardware target

- **Mac Mini M4** is the production target. M5 Pro is dev only.
- Bandwidth-ratio prediction (×2-2.5 slowdown) does **NOT** apply to MoE models with active-params routing — empirical measurement on M4 mandatory for any new model.

</requirements>

<findings_index>
## Feature Areas

| Area | Reference | Key Finding |
|------|-----------|-------------|
| Storage & Mutation | references/storage-and-mutation.md | events.md as source of truth + EventsWriter mutex; rename(2) read-modify-write loses 99% of updates under contention |
| LLM Tool Surface | references/tool-surface.md | `read_vault_multi` (batched) replaces singular `read_vault`; lenient discovery protocol; accept dual terminators |
| Performance | references/performance.md | -85.5% warm wall-clock on M4 with prefix-cache hygiene; context growth is the new bottleneck (Phase 1 deliverable: summarization) |
| Model Selection | references/model-selection.md | qwen3:30b-a3b-instruct-2507-q4_K_M primary; MoE A3B routing makes M4 faster than M5 Pro (defies bandwidth-ratio prediction) |
| Prompt Builder | references/prompt-builder.md | Pure-function builder + ESLint rule + CI test for SHA256 stability across builds |

## Source Files

Original spike source files (TypeScript runners, vault layout, shell scripts) preserved in `sources/`. Each subdir mirrors the spike number and name. Companion design docs are at `docs/superpowers/specs/2026-05-22-vault-llm-wiki-{design,risks}.md`.
</findings_index>

<metadata>
## Processed Spikes

All 14 spikes wrapped (11 ✓ VALIDATED, 1 ✗ INVALIDATED → design pivoted, 0 pending after sweep + narrative validation):

- 001-vault-harness-bootstrap (VALIDATED)
- 002-tool-discovery-compliance (PARTIAL → lenient mode adopted)
- 003-prefill-walltime-savings (VALIDATED)
- 004-m4-validation (VALIDATED — winner: qwen3:30b-a3b-instruct-2507-q4_K_M)
- 005-complex-turn-benchmark (PARTIAL → resolved by spike 009)
- 006-frontmatter-atomicity (INVALIDATED → events.md pattern adopted)
- 007-prefix-cache-stability (VALIDATED)
- 008-events-md-replay (VALIDATED)
- 009-read-vault-multi (VALIDATED)
- 010-events-md-concurrency (VALIDATED)
- 011-full-session-simulation (VALIDATED)
- 012-prompt-builder-stability (VALIDATED)
- 013-vault-backup-restore (VALIDATED)
- 014-narrative-quality (VALIDATED — primary confirmed)
</metadata>
