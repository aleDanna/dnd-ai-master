---
spike: 015
name: graphify-update-loop-m4
type: standard
validates: "Given a campaign markdown corpus that grows each turn, when the LLM appends a turn and the graphify graph is updated, then the update reflects the new entities/relations AND fits the M4 turn budget"
verdict: INVALIDATED
related: [008, 009, 011]
tags: [graphify, knowledge-graph, performance, extraction, ollama, m4, killer]
---

# Spike 015: graphify-update-loop-m4

## What This Validates

**Given** a campaign markdown corpus that grows by one turn each round,
**when** the LLM appends a turn and we update the graphify knowledge graph,
**then** the graph reflects the new entities/relations **and** the update fits
inside the M4 per-turn budget (validated warm turn = 3.78 s; Phase-1 target < 10 s).

This is the **killer** spike for the user's use-case 2 ("the LLM updates the
campaign graph each turn so it can recall an NPC from 30 turns ago"). If graphify
can't be kept current within the turn budget, the *live* dynamic-graph premise dies.

## Research (graphify internals — from source, `graphifyy==0.8.31`)

Read `graphify/llm.py`, `graphify/extract.py`, full `graphify --help`.

- **Build command is `graphify extract <path>`** (AST + semantic LLM). The graph
  (`graphify-out/graph.json`) is a **derived artifact** over a corpus — graphify
  is a query/extraction layer, **not** a storage/authoring layer. It does not
  replace the markdown vault; it sits on top of it.
- **Backends:** `gemini | kimi | claude | openai | deepseek | ollama | bedrock |
  claude-cli`. **`ollama` is supported** (OpenAI-compat `localhost:11434/v1`,
  model via `--model`/`OLLAMA_MODEL`) → local-only extraction is possible, no cloud
  required. Ollama is forced serial (1 GPU) unless `GRAPHIFY_OLLAMA_PARALLEL=1`.
- **Semantic extraction is batch full-corpus.** `extract_corpus_parallel` packs
  files into ~60k-token chunks and makes **one LLM call per chunk** with a fixed
  JSON-schema extraction prompt. Adaptive retry bisects a chunk on truncation.
- **No incremental write path for narrative.** `update <path>` is "re-extract
  **code** files (no LLM)" — AST/tree-sitter only. Prose/state changes require a
  full semantic re-`extract`. `check-update`/`needs_update` confirms the intended
  model is **periodic batch re-extraction**, not per-turn mutation.
- Extraction prompt targets code/citation relations (`calls|implements|references|
  cites|conceptually_related_to|shares_data_with`) — not narrative state.

| Approach | How an NPC-from-30-turns-ago would be kept current | Fit |
|----------|----------------------------------------------------|-----|
| Live per-turn `extract` (this spike) | Re-run semantic extraction every turn | tested below |
| Batch projection | Re-`extract` at session boundary / every N turns / on `needs_update` | plausible (untested here) |
| AST `update` | n/a — code only, not narrative | not applicable |

**Chosen for the test:** local `ollama` backend with the production primary
`qwen3:30b-a3b-instruct-2507-q4_K_M`, to measure the *real* per-turn cost on the
project's actual stack.

## How to Run

```bash
cd .planning/spikes/015-graphify-update-loop-m4
uv tool install "graphifyy[ollama]" --force            # ollama backend needs the openai dep
export OLLAMA_API_KEY=ollama OLLAMA_BASE_URL=http://localhost:11434/v1
MODEL=qwen3:30b-a3b-instruct-2507-q4_K_M
# warm the model, then:
graphify extract corpus --backend ollama --model "$MODEL" --max-concurrency 1 --no-cluster
graphify query "chi e Borin" --graph corpus/graphify-out/graph.json   # cheap read
```

## What to Expect

- `extract` runs for **minutes** (one ~30B LLM call per chunk, serial).
- `query` returns in **~0.16 s** (pure BFS, no LLM).
- See `results/measurements.md` for the numbers.

## Investigation Trail

1. **First run failed on a missing dep** — `uv tool install graphifyy` omits
   `openai`, which the ollama backend needs. Fix: `graphifyy[ollama]`. (Gotcha #1.)
2. **Full-corpus extract (12 turni): 425 s.** Produced 19 nodes / 34 edges — entity
   capture is actually good (Borin, Amuleto di Selûne, Vossk, Spada Fiammaluce,
   Lyra, Thorne, Pip…) **but with duplicates** because the 2-file chunk truncated,
   bisected, and each half re-created the shared nodes. Most of the 425 s was a
   *retry storm*: the first attempt rambled to the 16k output cap before truncating.
3. **Isolated the per-turn cost** — appended Turno 13, re-extracted **only**
   `events.md` with a 6k output cap. Result: **355 s and 0 nodes.** The model
   generated **14,930 output tokens** of invalid JSON (Ollama ignored the cap),
   truncated, and a single file can't bisect → total failure. So per-turn
   extraction on the local model is not just slow, it's **unreliable**.
4. **Read side is cheap** — `query` over the existing graph: **0.159 s**, no LLM.
   Confirms the architecture split: expensive write (extraction), cheap read.

## Results

**Verdict: ✗ INVALIDATED** — for the literal premise ("LLM updates the graph each
turn"). Live per-turn graph maintenance via graphify on the local primary model is
**~94–112× over the 3.78 s turn budget** (355–425 s) **and unreliable** (one run
produced 0 usable nodes). There is no incremental narrative-write path; the only
mechanism is full semantic re-extraction.

**What survives (reshape, not total kill):**
- **Reads are cheap and local (0.16 s).** A *pre-built* graph is excellent to query.
- Viable architecture = **batch projection**: the `events.md` vault stays the
  source of truth (as already locked by spikes 006/008); a graphify graph is
  rebuilt **offline** (session boundary / every N turns / on `needs_update`) and
  used as a **read-only retrieval index** at runtime. This is "augment the vault
  with a periodically-rebuilt graph index", **not** "migrate to graphify instead
  of Obsidian".
- Even batch extraction is slow/unreliable with the local 30B model → open question
  whether a faster/cloud extraction backend or a smaller extraction model is needed
  for the batch job (carries into 016).
- **Semantic cache helps the batch path.** graphify caches extraction per
  file-content hash (`graphify-out/cache/semantic/`), so a rebuild only re-extracts
  *changed* files. If campaign state lived in granular per-entity files (the
  materialized views from spike 008) instead of one monolithic `events.md`, a turn
  would re-extract only the 1–2 changed entities and cache-hit the rest — narrowing
  per-turn cost from ~355 s toward tens of seconds. Still over budget for *live*
  use, but it makes a **batch/near-real-time** projection genuinely cheap. This is a
  real design lever for 017.

**Impact on remaining spikes:** 016/017/018 should be reframed around a
**batch-built** graph queried at runtime (not a live per-turn graph):
- 016 (extraction quality) — now also must judge whether local-model extraction is
  reliable *at all*, or whether a cloud/other backend is required.
- 017 (coherence recall) — graph-query vs vault-read, with the graph treated as a
  periodically-refreshed index.
- 018 (static rules) — unaffected; the rules corpus is static, so a one-time batch
  build is the natural fit (its sweet spot).

**Limitations:** measured on M5 Pro (informative, not decision-grade per CONVENTIONS).
The 100× gap is far too large for M4-vs-M5 differences to change the verdict;
spike 004 indicates M4 is ≈/faster for this MoE model, so M5 is a pessimistic bound.
