# Vault-as-LLM-Memory Migration — Investigation Spike

**Status:** Investigation / Exploration
**Date:** 2026-05-22
**Author:** Spike investigation via `/gsd-explore`
**Companion doc:** [2026-05-22-vault-llm-wiki-risks.md](./2026-05-22-vault-llm-wiki-risks.md)

---

## 1. Motivation

Investigate replacing the current RAG-based knowledge layer (Postgres + pgvector + Ollama embedder) and the dynamic state layer (Postgres + drizzle) with a single **filesystem-only markdown vault** navigated directly by the LLM.

**Driving pains (selected during exploration):**

1. **Per-turn latency** — embedder cold-start (10-20s), pgvector query (~500ms), prompt prefill dominated by static blocks
2. **Prompt size** — static system prompt is ~38K tok (non-baked) or ~8.8K tok (baked), dwarfing the dynamic content per turn

**Pains NOT driving the migration:**

- Operational surface (multiple services to manage)
- Manual editability of lore/state via Obsidian app

These rankings shaped the design: the vault is a **performance instrument**, not a UX/authoring tool. Obsidian-the-app is optional.

---

## 1.5 Target hardware (production)

**Production target: Mac Mini M4** (10-core CPU, 10-core GPU, **32GB RAM**, **120 GB/s memory bandwidth**, 256GB SSD). The MacBook Pro M5 Pro (48GB / 307 GB/s) is *dev machine only*. All performance estimates must use M4 numbers.

**Implications that compound the case for migration:**

- **Memory bandwidth 120 GB/s vs 307 GB/s** → LLM inference is memory-bandwidth-bound. Token/s on M4 are roughly 40-50% of M5 Pro at the same model.
- **32GB RAM with OS + Next.js + Postgres ≈ 22-24 GB usable for Ollama.** qwen3:30b Q4 (~18-20 GB) leaves only ~3 GB headroom — embedder co-residence (`OLLAMA_MAX_LOADED_MODELS=2`) is fragile. **Eliminating the embedder entirely (vault has no embedder) is a much bigger win on M4 than on M5 Pro.**
- **256 GB SSD** caps the number of baked model variants you can keep installed (each ~14-20 GB). Multiple baked variants for different scenarios is borderline infeasible. **Vault content is KB-MB, not GB → near-zero storage footprint.**
- **Realistic local model candidates on M4:** qwen3:8b (~5 GB), mistral:24b Q4 (~14 GB). qwen3:30b is at the hard limit; co-loading anything else means it gets evicted under pressure.
- **CRITICAL CORRECTION (added 2026-05-24 after spike 004 M4 sweep):** The bandwidth-ratio prediction (×2-2.5 slowdown on M4) **does NOT apply to MoE models with active-params routing**. `qwen3:30b-a3b-instruct-2507-q4_K_M` activates only 3B of its 30B parameters per token via the A3B MoE router — wall-clock behaves like a 3-8B dense model, not a 30B one. Measured M4 warm wall = **3.78 s** (faster than the M5 Pro gpt-oss:20b measurement of 4.5 s in spike 003). The model is the surprise winner of the M4 sweep. Primary model selection updated below.

## 2. Current state baseline (measured)

Source: codebase analysis of `src/ai/master/system-prompt.ts`, `src/ai/master/slim-prompts.ts`, `src/ai/master/baked-models.ts`, `scripts/build-local-models.ts`, `src/app/api/sessions/[id]/turn/route.ts`, `src/ai/provider/local.ts`. Telemetry numbers below are from `ai_usage` data + design doc.

**Important:** raw timing numbers in code/commit history are M5 Pro dev measurements. M4 production estimates derived by applying the **bandwidth-scaled penalty (×2-2.5)** to prefill and **token-rate halving** to decode. Empirical M4 measurement is mandatory before commitment (see open questions).

### Static prompt composition (tokens, char/4 heuristic)

| Block | Tokens | Notes |
|---|---|---|
| `MASTER_TOOL_CONTRACT` | **~15,223** | The actual elephant — bigger than handbook+lore combined |
| `srdContext` (SRD compact) | ~7,000 | rules + conditions |
| `worldLore` full | ~6,860 | non-baked only |
| `handbook` full | ~4,612 | non-baked only |
| `MASTER_SYSTEM_PROMPT_BASE` | ~1,456 | |
| `MASTER_ROLL_TRIGGERS` | ~1,182 | |
| `MASTER_REWARDS_MANDATE` | ~1,015 | |
| `MASTER_META_TOOLS_INSTRUCTION` | ~469 | local-only |
| `MASTER_MEMORY_TOOL_RULE` | ~283 | |
| **Non-baked subtotal** | **~38,100** | |
| **Baked subtotal (slim variants)** | **~8,790** | TOOL_CONTRACT_SLIM = 218, HANDBOOK_ULTRA_SLIM = 254 |
| RAG block (k=3) per-turn | ~900-1,000 | baked-only, gated by `useRagRetrieval` |
| Snapshot (EngineState) per-turn | ~1,000-3,000 | always |

### Observed timing (M5 Pro dev) and M4 target estimates

Measured on M5 Pro dev machine, then scaled to M4 production target:

| Metric | M5 Pro dev (measured) | M4 prod (estimated ×2-2.5) |
|---|---|---|
| Non-baked qwen3:30b warm prefill | ~45s | **~100-115s** (!) |
| Baked + KV-cache hit prefix | ~10s | **~22-25s** |
| Decode rate (qwen3:30b-a3b, thinking-ON) | 22.9 tok/s | **~10-11 tok/s** |
| Embedder cold-start (post-master load) | 10-20s | **15-30s** (worse: RAM pressure) |
| pgvector retrieval (embed + cosine) | ~500ms | **~800ms-1s** |

These M4 estimates are the *baseline that the vault migration must beat*. The user-facing turn on M4 today is essentially: ~25s prefill + ~500ms RAG + (response_tokens / 10) decode. A 1000-token response = **35-40s total per turn**. This is on the edge of "unusable" — and the primary motivation for the migration.

### Theoretical floor

If handbook + lore + SRD + REWARDS_MANDATE + ROLL_TRIGGERS are removed from the static prompt and the tool contract is lazy-loaded, the floor is:

```
BASE_SLIM (518) + TOOL_CONTRACT_SLIM (218) + META_TOOLS (469)
+ MEMORY_RULE (283) + dynamic snapshot (~1500)  ≈ 3,000 tok
```

**Net savings vs current baseline:** 92% (non-baked) / 66% (baked).

---

## 3. Proposed architecture

### 3.1 Storage model

**Filesystem-only markdown vault.** Files (`.md`) on disk are the source of truth. The Next.js application reads and writes them directly via `fs/promises`. Obsidian-the-app is optional (visual inspection only).

No Postgres for knowledge or dynamic game state. Postgres retained only for:
- `ai_usage` (telemetry — append-only, doesn't need migration)
- Authentication / billing (if/when added)

### 3.2 Vault layout

```
/vault
  /handbook/                      ← static, path-deterministic
    /spells/<spell-id>.md
    /monsters/<monster-id>.md
    /items/<item-id>.md
    /rules/<topic>.md
    /classes/<class>.md
    index.md                      ← TOC (~300 tok), embedded in system prompt

  /campaigns/<campaign-id>/       ← dynamic, link-traversal entry
    index.md                      ← entry point: status, party, current session
    campaign.md                   ← frontmatter: tonal_frame, premise, language
    characters/
      <name>.md                   ← frontmatter: hp, slots, conditions, inventory
                                  ← body: bio, history, NPC relationships
    sessions/
      <n>.md                      ← frontmatter: date, scene, status
                                  ← body: narrative log
    world/
      <location-id>.md            ← frontmatter: visited, last_visited
                                  ← body: description, NPCs, events
    events.md                     ← append-only audit log (mutations, corrections)

  /tools/                         ← tool contract as markdown (lazy-loaded)
    index.md                      ← compact tool list with 1-line descriptions
    <tool-name>.md                ← schema, examples, constraints
```

### 3.3 Retrieval strategy (hybrid)

Based on user's explicit design choice during exploration:

**Static knowledge → path-deterministic.**
LLM learns the path schema from system prompt (~50-100 tok). To get spell info: `read_vault("/handbook/spells/<id>.md")`. Zero search, 1 read per access. Requires disciplined naming.

**Dynamic state → wiki-link traversal.**
LLM starts from `/campaigns/<id>/index.md`, follows `[[wiki-links]]` toward related entities (PCs, sessions, locations). Tool `read_vault(path)` returns content + extracted outgoing links so the LLM can navigate. Mirrors the Karpathy LLM Wiki pattern.

**Fallback for cold lookups:** `search_vault(query)` — ripgrep or SQLite FTS5 over the vault. 2 tool calls per access (search → read) but flexible for cases where path/link is unknown.

### 3.4 Mutability model

Based on user's explicit design choice: **frontmatter + body per file.**

- **Frontmatter YAML** = structured mutable state (hp, slots, conditions, inventory).
- **Body markdown** = narrative content (bio, session log, NPC dialogue).
- **Atomic single-file mutation**: `patch_frontmatter(path, updates)` does read-modify-write with POSIX `rename(2)` for atomicity. Body appends use `O_APPEND`.

**Cross-file consistency** (e.g., a single move updates HP on character.md AND posizione on session.md AND inventory on character.md) is NOT transactional. Mitigation:
- Single-agent assumption: no concurrent turns per campaign (enforced at API layer).
- Append all mutations to `events.md` first, then apply file mutations. On crash, replay from last applied event ID.
- This effectively gives event-sourcing semantics on top of the readable frontmatter snapshot.

### 3.5 Tool contract lazy-loading

The 15K-tok elephant. Replace inline tool contract in system prompt with:
- Compact instruction (~150 tok): "You have tools available. Read `/tools/index.md` for the list, then `/tools/<name>.md` for any tool's full schema before calling it."
- `/tools/index.md` (~500 tok): tool name + 1-line description per tool.
- `/tools/<name>.md`: full JSON schema, parameter docs, examples, error modes.

**Trade-off:** LLM may need 1-2 extra tool calls per turn for discovery (especially on cold-start of a session). Mitigation: KV-cache hit on `/tools/index.md` once read at session start; subsequent turns benefit. After a few turns the LLM internalizes which tools are used most often.

**Open risk:** smaller local models (mistral 24b, qwen3 8b) may not be disciplined enough to call `read /tools/foo.md` before using `foo`. Karpathy-style pattern was demonstrated on Claude-class models — local model behavior unproven for this project. (See risk register.)

### 3.6 Per-turn pipeline

```
1. Build system prompt:
   - BASE_SLIM (518 tok)
   - Vault root path + path schema for static (~80 tok)
   - Tool discovery instruction (~150 tok)
   - Active campaign pointer: "Current campaign: /campaigns/<id>/" (~30 tok)

2. Pre-load (1 read):
   - /campaigns/<id>/index.md (~500 tok max)
   - Embedded as user-context block.

3. LLM turn loop:
   - LLM emits tool calls: read_vault, patch_frontmatter, append_body, search_vault, game-specific actions
   - Each tool result feeds back into context (typical 200-2000 tok per read)
   - Turn ends with `end_turn` or `respond_to_player`

4. Mutation finalization:
   - All structured mutations go through events.md append first
   - Then frontmatter patches applied
   - On any failure: events.md is source of truth for replay
```

---

## 4. Expected impact

Two tables: one on dev machine (M5 Pro, for reference) and one on the production target (M4, the one that matters).

### M5 Pro dev (reference)

| Metric | Status quo (baked) | Vault wiki (target) | Delta |
|---|---|---|---|
| Static prompt tokens | ~8,790 | ~3,000 | **-66%** |
| Embedder cold-start | 10-20s (first turn) | 0 (no embedder) | **eliminated** |
| Per-turn prefill (warm) | ~10s (KV-cache hit) | ~2-4s (smaller prompt) | **-60%** est. |
| Per-turn tool calls | 2-4 typical | 3-6 typical | **+1-2 calls** |
| Per-turn wall-clock (1K resp) | ~15-25s | ~10-20s? | **NOT GUARANTEED** |

### M4 production (the real target) — MEASURED 2026-05-24 via spike 004

Replaces the prior estimates. Primary model is `qwen3:30b-a3b-instruct-2507-q4_K_M`.

| Metric | Status quo (baked dnd-master-plus) | Vault (qwen3-a3b-instruct-q4_K_M) | Delta |
|---|---|---|---|
| Static prompt tokens | ~8,790 | ~3,000 | **-66%** |
| Embedder cold-start | 15-30s (first turn, worse w/ 32GB pressure) | 0 (no embedder) | **eliminated** |
| Per-turn wall-clock (warm) | **26,052 ms** | **3,782 ms** | **-85.5%** ✓ |
| Per-turn wall-clock (cold) | **34,856 ms** | **15,746 ms** | **-54.8%** ✓ |
| Avg prefill (warm, cumulative) | 42 ms | 1,097 ms | +2,512% |
| Avg eval (decode) per turn | dominates baked wall | ~2.7 s | drastically lower |
| G2 lenient tool compliance | n/a (no tool surface) | **100%** | n/a |
| Output quality (5-keyword check) | 4/5 | 4/5 | parity |
| SSD budget for baked variants | ~14-20 GB × N | ~0 GB (vault is KB) | **frees disk** |
| Loaded models (RAM pressure) | master + embedder = ~20GB | master only = ~18GB | **less eviction churn** |

**Validation status (2026-05-24):** the M4 case is now empirically confirmed at **-85.5% warm wall-clock**, not just "favorable". The surprise upside came from the MoE A3B routing — active-3B params decode at the cost of a small dense model regardless of total-param count. The chosen `qwen3:30b-a3b-instruct-2507-q4_K_M` was not even the front-runner in the design's a-priori analysis (gpt-oss:20b was) — empirical sweep produced a better candidate on the actual target hardware.

LlamaIndex's 2026 benchmark ([filesystem agent vs RAG](https://www.llamaindex.ai/blog/did-filesystem-tools-kill-vector-search)) shows filesystem agents win on **quality** (correctness 8.4 vs 6.4) but can lose wall-clock at small scale due to extra round-trips. That risk is *lower* on a memory-bandwidth-bound machine like M4 where prefill dominates wall-clock — but still must be measured, not assumed.

**Bonus M4-specific wins not visible in the latency table:**
- **SSD reclaim:** dropping baked variants in favor of a vault-fed base model could free 50-100 GB on a 256 GB SSD. Storage stress on M4 is real.
- **RAM headroom:** removing the embedder from active rotation simplifies `OLLAMA_KEEP_ALIVE` tuning and reduces eviction churn under memory pressure.
- **Fewer baked variants:** since handbook/lore/SRD live in vault, you no longer need per-base-model "baked" variants. Just keep 2-3 generic Ollama models. Less rebuild work on schema changes.

---

## 5. External reference patterns

This design aligns with multiple in-the-wild patterns, all dated within 12 months of this spike:

- **Karpathy's LLM Wiki** ([VentureBeat, April 2026](https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an)) — canonical reference. `index.md` + folder hierarchy + grep/FTS5 + append-only `log.md`. No embeddings.
- **MCPVault** ([github.com/bitbonsai/mcpvault](https://github.com/bitbonsai/mcpvault)) — production-ready Obsidian vault as agent persistent memory; YAML-corruption-safe; filesystem-direct.
- **obsidian-llm-wiki** ([github.com/2233admin/obsidian-llm-wiki](https://github.com/2233admin/obsidian-llm-wiki)) — compiles vault to JSON graph cached, multi-persona MCP team.
- **memweave** ([TDS article](https://towardsdatascience.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required/)) — markdown + SQLite FTS5, zero vector DB. Blueprint for the search fallback.
- **SwarmVault** ([github.com/swarmclawai/swarmvault](https://github.com/swarmclawai/swarmvault)) — local-first vault explicitly built on Karpathy's pattern.
- **Letta benchmark** ([letta.com](https://www.letta.com/blog/benchmarking-ai-agent-memory)) — filesystem-only memory matches vector approaches on accuracy.

---

## 6. Scope boundaries

**IN scope (this design):**
- Replace RAG (handbook + lore + SRD) with vault static layer.
- Migrate `characters`, `session_state`, `campaigns` (knowledge fields) from Postgres to vault.
- Lazy-load tool contract from `/tools/`.
- Keep single-agent / one-turn-at-a-time invariant.

**OUT of scope (this design):**
- Multi-agent / concurrent-session handling (would require locking or full event-sourcing).
- Migration from production Postgres to vault (separate migration plan needed; see open questions).
- `ai_usage` telemetry (stays in Postgres — append-only, doesn't affect prompt).
- Audio/TTS providers (untouched).
- Multi-tenant / SaaS scenarios.

---

## 7. Decisions locked during this spike

1. **Obsidian role:** filesystem-only storage. Obsidian-the-app optional.
2. **Static retrieval:** path-deterministic.
3. **Dynamic retrieval:** wiki-link traversal from `/campaigns/<id>/index.md`.
4. **Mutability:** frontmatter + body per file. Cross-file consistency via `events.md` append-only log.
5. **Scope:** vault replaces everything in the knowledge + dynamic state layer, including tool contract.

---

## 8. Open questions (to resolve before a plan-phase)

1. **Tool discovery reliability on local models** — Will mistral 24b / qwen3 8b actually read `/tools/index.md` before using a tool, or will they hallucinate tool calls? Needs empirical test. *(Highest risk to project viability.)*
2. **Wall-clock measurement** — Real `prompt_eval_duration_ms` reduction at target prompt size on M5 Pro, with realistic turn (3-5 tool round-trips). Without numbers, the "performance win" is speculative.
3. **FTS5 vs ripgrep** — For `search_vault`: SQLite FTS5 (better ranking, ~1ms) or ripgrep (zero setup, ~50ms)? Memweave uses FTS5; depends on vault size at scale.
4. **Migration path** — How do existing campaigns in Postgres become vault directories? Big-bang export script vs dual-write coexistence period.
5. **Backup / git versioning** — Vault on disk: commit-on-write to a separate `vault-backup` git repo? Daily snapshot? S3 sync? Backup story is much different from `pg_dump`.
6. **Multi-campaign concurrency** — If user runs two campaigns in parallel (different sessions), per-campaign mutex sufficient or need finer-grained? Likely fine for now, document the invariant.
7. **Index.md staleness** — `/handbook/index.md` and `/campaigns/<id>/index.md` are denormalized TOCs. Who keeps them current? Auto-regenerate on file create/delete (filesystem watcher) or part of `patch_frontmatter` semantics?

---

## 9. Recommended next steps

**Before any implementation work:**

1. Run an **empirical spike** (1-2 days, separate task): standalone Node script that simulates the Karpathy pattern over a subset (just `/handbook/spells/` as path-deterministic static). Measure:
   - `prompt_eval_duration_ms` on M5 Pro at ~3,000 tok prompt vs status quo ~8,790
   - End-to-end turn wall-clock on 5 realistic scenarios (3-5 tool calls each)
   - Tool discovery reliability across mistral 24b, qwen3 8b, qwen3 30b (cold start, no prior session)
2. Read the [companion risk register](./2026-05-22-vault-llm-wiki-risks.md) and decide which risks need pre-implementation mitigation.
3. If both signals are positive, write a phased migration plan (Phase 1: static read-only, Phase 2: dynamic state, Phase 3: tool contract lazy). Each phase shippable independently with go/no-go gate.

**Do NOT start full migration without empirical numbers.** The literature is split: quality wins, wall-clock uncertain. Without measurement, we may invest weeks and end up slower.

---

## 10. References

- Karpathy LLM Wiki pattern — VentureBeat coverage, April 2026
- MCPVault — `github.com/bitbonsai/mcpvault`
- obsidian-llm-wiki — `github.com/2233admin/obsidian-llm-wiki`
- memweave — Towards Data Science article
- LlamaIndex filesystem benchmark — `llamaindex.ai/blog/did-filesystem-tools-kill-vector-search`
- Letta memory benchmark — `letta.com/blog/benchmarking-ai-agent-memory`
- Memory Vault post-mortem — `medium.com/@vivioo.io/your-ai-agent-keeps-forgetting-76d7bcefacf0`
- Stop Using Markdown For Memory — `stopusingmarkdownformemory.com` (counter-argument)
- 3000-op LLM agent memory test — `dev.to/mahendra4/i-tested-3000-llm-agent-memory-operations`
- ESAA event-sourcing for agents — `arxiv.org/pdf/2602.23193`

**Internal references (current codebase):**

- `src/ai/master/system-prompt.ts` — buildMasterSystemPrompt
- `src/ai/master/slim-prompts.ts` — slim variants
- `src/ai/master/baked-models.ts` — baked variant strategy
- `src/ai/master/rag/{embedder,store-pgvector,retriever,indexer}.ts` — current RAG layer to retire
- `src/ai/master/tool-loop.ts` — turn loop to extend with vault tools
- `src/db/schema/ai-usage.ts` — telemetry schema (retained)
- `scripts/build-local-models.ts` — modelfile generation (will simplify)
- `scripts/build-rag-index.ts` — to be replaced
- `data/master_handbook.md` / `data/master_world_lore.md` — source content to split into vault structure
