# Project: dnd-ai-master

## Overview

A D&D 5e AI Dungeon Master web application. Runs as a Next.js server with local LLM inference via Ollama. Players interact through a chat-style UI; an LLM master handles narration, rules adjudication, NPC voicing, combat resolution, and game-state mutations.

Existing production stack:
- Next.js App Router (Node.js runtime)
- Postgres + drizzle-orm for game state (campaigns, characters, session_state, ai_usage)
- Postgres + pgvector for RAG (handbook + world lore + SRD) with Ollama embedder (`nomic-embed-text`)
- Multi-provider LLM (Anthropic cloud preferred, Ollama local fallback with baked `dnd-master-*` variants)

## Current Milestone

**Vault-LLM-Wiki Migration** (2026-05 — present)

Replace the RAG-based knowledge layer AND the Postgres dynamic-state layer with a **filesystem-only markdown vault** navigated by the LLM via tool calls. Static knowledge (handbook, spells, monsters, rules) uses path-deterministic access; dynamic state (campaigns, characters, sessions) uses event-sourced markdown with materialized views.

### Motivation

Two pains drove the migration (locked from `/gsd-explore` 2026-05-22):
1. **Per-turn latency** — RAG embedder cold-start (10-20s), pgvector query (~500ms), prompt prefill dominated by 38K-token static blocks
2. **Prompt size** — `MASTER_TOOL_CONTRACT` alone is 15K tokens; static prompt is 38K non-baked / 8.8K baked

### Validation status

Migration is **technically feasible** (validated across 14 spikes, 3 rounds + narrative iteration, 2026-05-22 through 2026-05-24):

- **G1 (wall-clock ≥40% warm on M4):** ✓ GREEN — measured **-85.5%** on production hardware (3.78 s vault warm vs 26 s baked baseline)
- **G2 (tool discovery ≥90% lenient):** ✓ GREEN — 100% on chosen primary model
- **R3/R4 (mutation safety):** ✓ GREEN — `EventsWriter` mutex handles 100 concurrent appends with 0 lost
- **R7 (DR):** ✓ GREEN — byte-exact restore via `git + events.md replay`
- **Quality preservation:** ✓ GREEN — keyword parity + narrative quality tied or better than baked

### Target hardware

**Production:** Mac Mini M4 (32GB RAM, 120 GB/s bandwidth, 256GB SSD). M5 Pro is dev only.

### Primary model

`qwen3:30b-a3b-instruct-2507-q4_K_M` (selected via spike 004 M4 sweep + spike 014 narrative validation). Surprise finding: M4 with this MoE A3B model is faster than M5 Pro with `gpt-oss:20b` — active-3B routing decouples decode cost from total params.

## Companion artifacts (read first)

- **Implementation blueprint:** `Skill("spike-findings-dnd-ai-master")` (auto-loaded via CLAUDE.md)
- **Design doc:** `docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md`
- **Risk register:** `docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md`
- **Spike wrap-up:** `.planning/spikes/WRAP-UP-SUMMARY.md`
- **Spike conventions:** `.planning/spikes/CONVENTIONS.md`

## Out of scope for this milestone

- Multi-user / multi-tenant (single-developer, single-user single-campaign-at-a-time)
- Multi-agent concurrent campaigns (single-writer invariant per campaign_id)
- Cloud Anthropic master (retained as existing capability, untouched)
- Audio/TTS providers (untouched)
- Frontend redesign (retain existing chat UI, only the master backend changes)
