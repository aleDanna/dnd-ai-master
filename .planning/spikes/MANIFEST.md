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
- **Tool surface must include `read_vault_multi`** (added by spike 005, validated by 009). Multi-fact lookups in complex turns require batched reads. Spike 009 measured -59.7% wall-clock improvement vs sequential AND quality went 2/5 → 5/5. **Drop singular `read_vault` from tool surface entirely** to prevent footgun.
- **Single-writer queue for events.md via in-process mutex** (validated by spike 010). 100/100 concurrent appends in 7ms, 0 lost/corrupted/duplicated. Enforced at `campaign_id` granularity.
- **Per-turn summarization required for long sessions** (added by spike 011). Context growth (accumulated tool_result history) is the new primary bottleneck. Trigger: cumulative prompt > 15K tokens → condense prior 5 turns into a 200-word summary block.
- **DR procedure: events.md is the only file that needs durable backup** (validated by spike 013). Derived views are regenerable. Vault = git repo. Restore = `git clone` + replay script.
- **Tool contract = lazy-loaded via index** (revised by spike 002): LLM reads `/tools/index.md` once at session start, then may use any listed tool directly. Per-tool `/tools/<name>.md` lookups are optional/preferred but not enforced. Strict per-tool lookup proved impractical on local models; index-based discovery achieves the same end (no inline tool contract) while matching observed model behavior.
- **Primary local model = gpt-oss:20b** (revised by spike 002). qwen3:30b-a3b retained as quality-fallback. llama3.2:3b eliminated (unable to follow tool protocol).
- **Server accepts both turn terminators:** `end_turn` tool call AND `no_tool_calls + content` are both valid completions.
- **Target hardware = Mac Mini M4.** All G1 wall-clock measurements must be validated on M4 before commit.

## Decision Gates (from risk register)

| Gate | Condition | Spike |
|---|---|---|
| **G1** | ≥40% wall-clock improvement on M4 (warm operation) | ✓ GREEN on M5 Pro with all mitigations stacked: 003 simple turns -63%, 009 complex turns -59.7% with read_vault_multi, 011 full session avg 7.4s (excl. outlier). M4 measurement still required (spike 004) — projected ~18.6s avg = decisive improvement over baked baseline ~30-80s. |
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
| 004 | m4-validation | comparison | Sweep 5 candidate models on M4 (mistral-small3.2:24b ±instruct/q4_K_M, qwen3:30b-a3b ±instruct-2507/q4_K_M); identify winner passing G1 ≥40% AND G2 ≥90% | ⏸ PENDING_M4 — script ready, sweeps 5 models, must run on M4 | g1, g2, m4, decision-grade, model-selection |
| 005 | complex-turn-benchmark | standard | A 5-tool-call multi-action turn maintains compliance ≥90% and wall-clock < 30s warm | ⚠ PARTIAL — warm Δ -1.1% (advantage gone); cold -42.7%; quality 5/5 | g1, g2, complex, ollama, hard-finding |
| 006 | frontmatter-atomicity | standard | 100 concurrent patch_frontmatter via rename(2) produces 0 corrupted YAML files | ✗ INVALIDATED — 99/100 lost updates; design pivots to events.md | r3, r4, mitigation, mutation, hard-finding |
| 007 | prefix-cache-stability | standard | System-prompt drift (byte-level) measurably degrades the warm advantage | ✓ VALIDATED — drift +101% wall, +306% prefill; hygiene mandatory | implementation-guard, kv-cache, ollama |
| 008 | events-md-replay | standard | 100-mutation events.md replays to a state matching golden frontmatter snapshots | ✓ VALIDATED — exact replay; corruption detected fast | r3, mitigation, event-sourcing |
| 009 | read-vault-multi | standard | Batched `read_vault_multi` reduces complex-turn roundtrips → warm wall ≥50% improvement | ✓ VALIDATED — warm Δ -59.7%; quality 2/5 → 5/5; prompt -84% tokens | g1, mitigation, complex-turn |
| 010 | events-md-concurrency | standard | 100 concurrent `apply_event` via single-writer queue → 0 lost, 0 corrupted, replayable | ✓ VALIDATED — 100/100 events in 7ms, 0 lost/corrupted/duplicated | r3, r4, mitigation, concurrency |
| 011 | full-session-simulation | standard | 10-turn realistic D&D session: avg warm < 25s on M5 Pro, quality ≥4/5 per turn | ✓ VALIDATED (excl. outlier) — avg 7.4s, quality 85.7%, prefix hash stable | g1, session-level, integration |
| 012 | prompt-builder-stability | standard | SystemPromptBuilder + linter: same inputs → identical SHA256; forbidden patterns rejected | ✓ VALIDATED — 6/7 (1 self-lint false positive documented) | implementation, ci-test |
| 013 | vault-backup-restore | standard | Corrupted derived views restored from events.md replay; byte-exact match to pre-corruption | ✓ VALIDATED — byte-for-byte restore via events replay | r7, dr, backup |

---

## Spike phase closed — 2026-05-24

**Verdict tally:** 11 ✓ VALIDATED, 1 ✗ INVALIDATED (→ design pivoted, mitigation found), 1 ⏸ PENDING_M4 (deferred to Phase 1).

**Outcome:** Migration `vault-llm-wiki` is **technically feasible**. Five stacked mitigations (read_vault_multi, EventsWriter mutex, stable prompt builder, events.md as source of truth, lenient tool protocol) form a cohesive design validated end-to-end on M5 Pro. Quality preserved or improved vs the baked baseline; warm wall-clock advantage in the -60% range on simple turns, recovered to similar magnitude on complex turns once `read_vault_multi` is used.

**Carried into the real build:**
- Spike 004 (M4 sweep across 5 candidates) runs **as the first task of Phase 1** — go/no-go gate on decision-grade hardware before any flip of production traffic.
- Phase 1 deliverables identified: SystemPromptBuilder + ESLint rule, read_vault_multi tool, EventsWriter mutex, events projector, per-turn summarization at 15K-token boundary.
- Companion docs (`docs/superpowers/specs/2026-05-22-vault-llm-wiki-*`) are the authoritative spec for plan-phase.

**Closed by:** explicit user signal "spike terminata" 2026-05-24. No further spikes planned in this round.
