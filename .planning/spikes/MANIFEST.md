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
- **Primary local model = `qwen3:30b-a3b-instruct-2507-q4_K_M`** (final, validated on feasibility by spike 004 AND on narrative quality by spike 014). M4 warm wall-clock 3.78 s, G2 lenient 100%, G1 -85.5% vs baked, narrative-quality tied at 9 pts with non-q4.
- **Quality-fallback (opt-in) = `qwen3:30b-a3b-instruct-2507`** (non-q4, 3.87 s warm, within 2.4%; marginally stronger NPC voicing and moral-choice dramaturgy per spike 014).
- **Offline content-only (non-default) = `mistral-small3.2:24b`**: failed G2 (80%) so not for live turns, but spike 014 showed it's the strongest local model for *authentic non-standard voice* (e.g. goblin pidgin). Useful tool for generating in-game found-text, foreign scripts, ritual writings — produced offline, stored as static vault content.
- **DROPPED entirely: `qwen3:30b-a3b` base** (spike 014 iteration 2): even with `think: false` the model leaks its English chain-of-thought into the content stream. Unusable for direct narrative output without a CoT extraction pipeline (out of scope).
- **gpt-oss:20b** retained as M5 Pro dev convenience only (not deployed to M4).
- **Server accepts both turn terminators:** `end_turn` tool call AND `no_tool_calls + content` are both valid completions.
- **Target hardware = Mac Mini M4.** All G1 wall-clock measurements must be validated on M4 before commit.

## Decision Gates (from risk register)

| Gate | Condition | Spike |
|---|---|---|
| **G1** | ≥40% wall-clock improvement on M4 (warm operation) | ✓ GREEN — decision-grade on M4 (spike 004 sweep): qwen3:30b-a3b-instruct-2507-q4_K_M achieves **-85.5%** warm (3.78 s vs 26 s baked baseline). Surprise: M4 faster than M5 Pro for this model — MoE A3B routing activates only 3B params, bypassing the bandwidth-ratio penalty. |
| **G2** | Lenient tool discovery compliance ≥90% (read `/tools/index.md` once, then use tools) | ✓ GREEN — decision-grade on M4 (spike 004): qwen3:30b-a3b-instruct-2507-q4_K_M 100%, qwen3 fallback 100%, qwen3-a3b base 100%. Mistral variants eliminated at 80%. |
| **R3/R4 mitigation** | Concurrent mutation safe under contention | ✗ Naive `rename(2)` FAILS (spike 006); ✓ events.md sourcing WORKS (spike 008) — design pivots accordingly |
| **Implementation guard** | Prefix-cache hygiene quantified | ✓ +101% wall / +306% prefill drift penalty (spike 007) |
| G5 | DR rehearsal | Out of scope for spike rounds 1-2 |

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | vault-harness-bootstrap | standard | Node script with Ollama client + 3 stub tools completes a happy-path D&D turn | ✓ VALIDATED — but lazy-tools protocol violated by best local model on 1st run | foundation, ollama |
| 002 | tool-discovery-compliance | standard | LLM reads `/tools/<name>.md` before invoking tool — ≥90% across cold turns, multiple models | ⚠ PARTIAL — strict 0%, lenient 100% on gpt-oss/qwen3; llama3.2:3b unsuitable | g2, compliance, ollama, model-selection |
| 003 | prefill-walltime-savings | standard | Vault path achieves ≥40% wall-clock improvement vs baked baseline | ✓ VALIDATED — warm -63.1% on M5 Pro; cold ~tie; quality preserved or better | g1, benchmark, ollama |
| 004 | m4-validation | comparison | Sweep 5 candidate models on M4; identify winner passing G1 ≥40% AND G2 ≥90% | ✓ VALIDATED — winner `qwen3:30b-a3b-instruct-2507-q4_K_M`: G1 -85.5%, G2 100%, warm 3.78s; both mistral variants eliminated | g1, g2, m4, decision-grade, model-selection |
| 005 | complex-turn-benchmark | standard | A 5-tool-call multi-action turn maintains compliance ≥90% and wall-clock < 30s warm | ⚠ PARTIAL — warm Δ -1.1% (advantage gone); cold -42.7%; quality 5/5 | g1, g2, complex, ollama, hard-finding |
| 006 | frontmatter-atomicity | standard | 100 concurrent patch_frontmatter via rename(2) produces 0 corrupted YAML files | ✗ INVALIDATED — 99/100 lost updates; design pivots to events.md | r3, r4, mitigation, mutation, hard-finding |
| 007 | prefix-cache-stability | standard | System-prompt drift (byte-level) measurably degrades the warm advantage | ✓ VALIDATED — drift +101% wall, +306% prefill; hygiene mandatory | implementation-guard, kv-cache, ollama |
| 008 | events-md-replay | standard | 100-mutation events.md replays to a state matching golden frontmatter snapshots | ✓ VALIDATED — exact replay; corruption detected fast | r3, mitigation, event-sourcing |
| 009 | read-vault-multi | standard | Batched `read_vault_multi` reduces complex-turn roundtrips → warm wall ≥50% improvement | ✓ VALIDATED — warm Δ -59.7%; quality 2/5 → 5/5; prompt -84% tokens | g1, mitigation, complex-turn |
| 010 | events-md-concurrency | standard | 100 concurrent `apply_event` via single-writer queue → 0 lost, 0 corrupted, replayable | ✓ VALIDATED — 100/100 events in 7ms, 0 lost/corrupted/duplicated | r3, r4, mitigation, concurrency |
| 011 | full-session-simulation | standard | 10-turn realistic D&D session: avg warm < 25s on M5 Pro, quality ≥4/5 per turn | ✓ VALIDATED (excl. outlier) — avg 7.4s, quality 85.7%, prefix hash stable | g1, session-level, integration |
| 012 | prompt-builder-stability | standard | SystemPromptBuilder + linter: same inputs → identical SHA256; forbidden patterns rejected | ✓ VALIDATED — 6/7 (1 self-lint false positive documented) | implementation, ci-test |
| 013 | vault-backup-restore | standard | Corrupted derived views restored from events.md replay; byte-exact match to pre-corruption | ✓ VALIDATED — byte-for-byte restore via events replay | r7, dr, backup |
| 014 | narrative-quality | comparison | Human-eval 4 candidates × 5 Italian narrative scenarios (scene, NPC, combat, choice, lore); identify model with best prose for narrative-heavy turns | ✓ VALIDATED — primary unchanged (q4_K_M tied with non-q4 at 9 pts); mistral useful for offline non-standard voice; qwen3-a3b BASE dropped (CoT leak even with think:false) | m4, narrative, qualitative, italian, human-eval, model-selection |
| 015 | graphify-update-loop-m4 | standard | graphify per-turn graph update reflects new state AND fits the M4 turn budget | ✗ INVALIDATED — per-turn semantic re-extraction 355–425s (~100× the 3.78s turn) AND unreliable (0 nodes one run, runaway JSON); reads cheap (0.16s, BFS); reshape → batch projection only, vault stays source of truth | graphify, knowledge-graph, performance, ollama, killer |

---

## Spike phase closed — 2026-05-24

**Verdict tally:** 13 ✓ VALIDATED, 1 ✗ INVALIDATED (→ design pivoted, mitigation found). All gates GREEN on production hardware. Narrative quality assessed and primary confirmed.

**Outcome:** Migration `vault-llm-wiki` is **technically feasible**. Five stacked mitigations (read_vault_multi, EventsWriter mutex, stable prompt builder, events.md as source of truth, lenient tool protocol) form a cohesive design validated end-to-end on M5 Pro. Quality preserved or improved vs the baked baseline; warm wall-clock advantage in the -60% range on simple turns, recovered to similar magnitude on complex turns once `read_vault_multi` is used.

**Carried into the real build:**
- Spike 004 (M4 sweep across 5 candidates) runs **as the first task of Phase 1** — go/no-go gate on decision-grade hardware before any flip of production traffic.
- Phase 1 deliverables identified: SystemPromptBuilder + ESLint rule, read_vault_multi tool, EventsWriter mutex, events projector, per-turn summarization at 15K-token boundary.
- Companion docs (`docs/superpowers/specs/2026-05-22-vault-llm-wiki-*`) are the authoritative spec for plan-phase.

**Closed by:** explicit user signal "spike terminata" 2026-05-24, finalized after M4 sweep results (commit `51dc6f8`) pulled from production hardware same day.

---

## Phase REOPENED — 2026-05-24

User raised a gap that the closure didn't address: **narrative quality and choice quality of the chosen primary model** were never measured (spikes 002-004 were feasibility benchmarks, not creative-writing benchmarks). Spike 014 added to close that gap. The closure note above still stands for the feasibility track (G1/G2 GREEN); narrative track is its own validation slice.

---

## Phase: graphify evaluation — 2026-06-04 (in corso)

### Idea
Evaluate adopting **graphify** (knowledge-graph extraction/query tool, `graphifyy` on PyPI, repo `safishamsi/graphify`) for two use cases: (1) a **static graph** of rules/handbook/static prompts; (2) **dynamic per-campaign graphs** kept current for long-horizon narrative coherence (recall an NPC introduced ~30 turns earlier). Original framing was "migrate to graphify instead of Obsidian"; **spike 015 corrected this** — graphify is a query/extraction layer over a corpus, not a storage layer, so the markdown vault (`events.md`, locked by spikes 006/008) remains source of truth and would *feed* graphify.

### Emerging requirements (graphify track)
- **graphify ≠ storage.** The `events.md` vault stays source of truth. Any graphify graph is a **derived projection**, never authoritative state.
- **No live per-turn graph updates** (spike 015): semantic extraction is batch full-corpus, ~355–425 s/run on the local primary model, and unreliable (runaway JSON; ollama ignores the output cap). If adopted, the graph is **batch-built offline** (session boundary / every N turns / on `needs_update`) and queried read-only at runtime.
- **Graph queries are cheap** (~0.16 s, pure BFS, no LLM) — the read side is viable at runtime.
- **ollama backend needs `graphifyy[ollama]`** (the `openai` dep) + `OLLAMA_API_KEY` (any value) + `OLLAMA_BASE_URL`.

### Spikes (this phase)
015–018, **reframed after 015** around a batch-built graph queried at runtime (not a live per-turn graph). 015 ✗ INVALIDATED (per-turn premise). 016/017/018 pending user go/no-go on the reshape.
