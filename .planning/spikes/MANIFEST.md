# Spike Manifest

## Idea

Validate the feasibility of migrating `dnd-ai-master` from RAG (Postgres + pgvector + Ollama embedder) and Postgres dynamic state to a **filesystem-only markdown vault** navigated directly by the LLM via tool calls. Static knowledge (handbook, spells, monsters, rules) uses path-deterministic access; dynamic state (campaigns, characters, sessions) uses wiki-link traversal with frontmatter+body files. Tool contract is lazy-loaded from `/tools/`. Target production hardware: **Mac Mini M4** (32GB RAM, 120 GB/s bandwidth, 256GB SSD).

Companion design docs:
- [docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md](../../docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md)
- [docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md](../../docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md)

## Requirements

Design decisions locked during `/gsd-explore`, non-negotiable for the real build unless explicitly revised:

- **Vault = filesystem-only.** Obsidian-app optional. Knowledge layer holds no DB.
- **Static retrieval = path-deterministic.** `/handbook/<category>/<id>.md`.
- **Dynamic retrieval = wiki-link traversal.** Entry from `/campaigns/<id>/index.md`.
- **Mutability = events.md append-only as source of truth; frontmatter files are materialized views** (revised by spike 006 + 008). Spike 006 invalidated naive `patch_frontmatter` via `rename(2)`: 99% lost updates under concurrent writes (atomic at FS layer ≠ safe read-modify-write). Spike 008 validated event-sourced replay (100 events → exact state match, corruption detected fast). Single-writer queue per `campaign_id` enforced at API layer.
- **Prefix-cache hygiene is MANDATORY** (added by spike 007). System prompt must be byte-stable across turns within a session. No timestamps, UUIDs, or per-turn counters in the prefix. Dynamic context goes in user-prepended messages, never in the system block. Drift penalty: +101% wall-clock, +306% first-prefill.
- **Tool surface must include `read_vault_multi`** (added by spike 005). Multi-fact lookups in complex turns require batched reads, otherwise N roundtrips × re-prefill of growing history erases the warm advantage.
- **Tool contract = lazy-loaded via index** (revised by spike 002): LLM reads `/tools/index.md` once at session start, then may use any listed tool directly. Per-tool `/tools/<name>.md` lookups are optional/preferred but not enforced. Strict per-tool lookup proved impractical on local models; index-based discovery achieves the same end (no inline tool contract) while matching observed model behavior.
- **Primary local model = gpt-oss:20b** (revised by spike 002). qwen3:30b-a3b retained as quality-fallback. llama3.2:3b eliminated (unable to follow tool protocol).
- **Server accepts both turn terminators:** `end_turn` tool call AND `no_tool_calls + content` are both valid completions.
- **Target hardware = Mac Mini M4.** All G1 wall-clock measurements must be validated on M4 before commit.

## Decision Gates (from risk register)

| Gate | Condition | Spike |
|---|---|---|
| **G1** | ≥40% wall-clock improvement on M4 (warm operation) | ⚠ MIXED on M5 Pro (-63.1% simple turns, -1.1% complex turns); spike 005 shows complex turns lose the advantage; spike 007 shows cache drift would erase it entirely. M4 measurement pending. |
| **G2** | Lenient tool discovery compliance ≥90% (read `/tools/index.md` once, then use tools) | ✓ GREEN on M5 Pro (002: gpt-oss:20b 100%, qwen3:30b 100%); M4 expected same (HW-agnostic) |
| **R3/R4 mitigation** | Concurrent mutation safe under contention | ✗ Naive `rename(2)` FAILS (spike 006); ✓ events.md sourcing WORKS (spike 008) — design pivots accordingly |
| **Implementation guard** | Prefix-cache hygiene quantified | ✓ +101% wall / +306% prefill drift penalty (spike 007) |
| G5 | DR rehearsal | Out of scope for spike rounds 1-2 |

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | vault-harness-bootstrap | standard | Node script with Ollama client + 3 stub tools completes a happy-path D&D turn | ✓ VALIDATED — but lazy-tools protocol violated by best local model on 1st run | foundation, ollama |
| 002 | tool-discovery-compliance | standard | LLM reads `/tools/<name>.md` before invoking tool — ≥90% across cold turns, multiple models | ⚠ PARTIAL — strict 0%, lenient 100% on gpt-oss/qwen3; llama3.2:3b unsuitable | g2, compliance, ollama, model-selection |
| 003 | prefill-walltime-savings | standard | Vault path achieves ≥40% wall-clock improvement vs baked baseline | ✓ VALIDATED — warm -63.1% on M5 Pro; cold ~tie; quality preserved or better | g1, benchmark, ollama |
| 004 | m4-validation | standard | Re-run 002+003 on Mac Mini M4 hardware; G1 ≥40% warm AND G2 ≥90% lenient hold | ⏸ PENDING_M4 — script ready, must run on M4 | g1, g2, m4, decision-grade |
| 005 | complex-turn-benchmark | standard | A 5-tool-call multi-action turn maintains compliance ≥90% and wall-clock < 30s warm | ⚠ PARTIAL — warm Δ -1.1% (advantage gone); cold -42.7%; quality 5/5 | g1, g2, complex, ollama, hard-finding |
| 006 | frontmatter-atomicity | standard | 100 concurrent patch_frontmatter via rename(2) produces 0 corrupted YAML files | ✗ INVALIDATED — 99/100 lost updates; design pivots to events.md | r3, r4, mitigation, mutation, hard-finding |
| 007 | prefix-cache-stability | standard | System-prompt drift (byte-level) measurably degrades the warm advantage | ✓ VALIDATED — drift +101% wall, +306% prefill; hygiene mandatory | implementation-guard, kv-cache, ollama |
| 008 | events-md-replay | standard | 100-mutation events.md replays to a state matching golden frontmatter snapshots | ✓ VALIDATED — exact replay; corruption detected fast | r3, mitigation, event-sourcing |
