# Spike Wrap-Up Summary

**Date:** 2026-05-24
**Spikes processed:** 14
**Feature areas:** Storage & Mutation, LLM Tool Surface, Performance, Model Selection, Prompt Builder
**Skill output:** `./.claude/skills/spike-findings-dnd-ai-master/`

## Processed Spikes

| # | Name | Type | Verdict | Feature Area |
|---|------|------|---------|--------------|
| 001 | vault-harness-bootstrap | standard | ✓ VALIDATED | Storage & Mutation |
| 002 | tool-discovery-compliance | standard | ⚠ PARTIAL (lenient adopted) | LLM Tool Surface |
| 003 | prefill-walltime-savings | standard | ✓ VALIDATED | Performance |
| 004 | m4-validation | comparison | ✓ VALIDATED | Model Selection |
| 005 | complex-turn-benchmark | standard | ⚠ PARTIAL (resolved by 009) | Performance |
| 006 | frontmatter-atomicity | standard | ✗ INVALIDATED (design pivoted) | Storage & Mutation |
| 007 | prefix-cache-stability | standard | ✓ VALIDATED | Performance |
| 008 | events-md-replay | standard | ✓ VALIDATED | Storage & Mutation |
| 009 | read-vault-multi | standard | ✓ VALIDATED | LLM Tool Surface |
| 010 | events-md-concurrency | standard | ✓ VALIDATED | Storage & Mutation |
| 011 | full-session-simulation | standard | ✓ VALIDATED | Performance |
| 012 | prompt-builder-stability | standard | ✓ VALIDATED | Prompt Builder |
| 013 | vault-backup-restore | standard | ✓ VALIDATED | Storage & Mutation |
| 014 | narrative-quality | comparison | ✓ VALIDATED | Model Selection |

## Key Findings

### Storage & Mutation (5 spikes)
- **events.md = source of truth.** Append-only log; per-entity `.md` files are materialized views regenerated from event replay.
- **Single-writer mutex (`EventsWriter`)** validated at 100 concurrent appends with 0 lost / 0 corrupted / 0 duplicated.
- **Naive read-modify-write with `rename(2)` atomicity FAILS catastrophically** — 99% lost-update rate under contention. Pattern abandoned (spike 006 INVALIDATED).
- **DR via git + replay** validated byte-exact restore. No `pg_dump` needed.

### LLM Tool Surface (2 spikes)
- **`read_vault_multi` is decisive.** Replaces sequential `read_vault` calls: -59.7% wall-clock + quality goes from 2/5 to 5/5 (spike 009).
- **Strict per-tool-doc protocol failed on every local model** (0-50% strict compliance). Lenient protocol (read `/tools/index.md` once) passes 100% on the chosen primary.
- **Accept dual terminators:** `end_turn` tool call OR `no_tool_calls + content`. qwen3 skips `end_turn` 40% of the time; rejecting that path discards valid responses.

### Performance (4 spikes)
- **-85.5% warm wall-clock on M4** vs baked baseline (3.78s vs 26s) with the chosen primary model.
- **Prefix-cache hygiene mandatory** — drift erases the warm advantage. SHA256-stable system prompt validated by spike 012.
- **MoE A3B routing makes M4 FASTER than M5 Pro** for this model (3.78s vs 4.5s gpt-oss:20b). Bandwidth-ratio prediction fails for MoE.
- **Context growth is the new bottleneck.** Turn 8 of a 10-turn session hit 22K prompt tokens. Phase 1 deliverable: per-turn summarization at 15K boundary.

### Model Selection (2 spikes)
- **Primary: `qwen3:30b-a3b-instruct-2507-q4_K_M`** — validated on both feasibility AND narrative quality.
- **Quality-fallback (opt-in): `qwen3:30b-a3b-instruct-2507`** — non-q4, within 2.4% wall-clock, marginally better NPC voicing.
- **Offline content tool: `mistral-small3.2:24b`** — failed G2 (80%) so not for live turns, but only model with authentic non-standard voice (goblin pidgin).
- **Eliminated:** qwen3:30b-a3b base (CoT leak), llama3.2:3b (0% compliance), mistral q4 (G1 regression).

### Prompt Builder (1 spike)
- **`SystemPromptBuilder` is a pure function.** 1000 builds with same input → 1 unique SHA256.
- **ESLint/CI rule forbids** `Date.now`, `Math.random`, `process.env`, `randomUUID`, `process.hrtime`, hostnames in the builder source.

## Decision Gates (all GREEN)

| Gate | Threshold | Measured | Status |
|---|---|---|---|
| G1 wall-clock | ≥40% warm improvement vs baked on M4 | -85.5% | ✓ GREEN |
| G2 tool compliance | ≥90% lenient | 100% on primary + fallback | ✓ GREEN |
| R3/R4 mutation safety | 0 lost under concurrent stress | 100/100 events persisted | ✓ GREEN |
| R7 DR | byte-exact restore from events.md | confirmed | ✓ GREEN |
| Quality preservation | ≥ baked baseline | tie or better on warm | ✓ GREEN |

## Phase 1 Deliverables (next step)

These are the concrete artifacts the implementation phase must produce, all already prototyped in spike source:

1. **`SystemPromptBuilder`** + ESLint rule + CI test
2. **`read_vault_multi`** tool implementation
3. **`EventsWriter`** mutex class + `apply_event` API
4. **Events projector** → derived view regeneration on read
5. **Per-turn summarization** at 15K-token boundary (NEW — not in any spike, but identified as Phase 1 requirement by spike 011)

## Companion Artifacts

- Design docs: `docs/superpowers/specs/2026-05-22-vault-llm-wiki-{design,risks}.md`
- Spike skill (this wrap-up): `.claude/skills/spike-findings-dnd-ai-master/`
- Conventions: `.planning/spikes/CONVENTIONS.md`
- M4 sweep raw logs: `.planning/spikes/004-m4-validation/results/`
- Narrative sweep raw logs: `.planning/spikes/014-narrative-quality/results/`
