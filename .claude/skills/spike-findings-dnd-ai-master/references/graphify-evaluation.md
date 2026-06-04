# Graphify Evaluation

> **DECISION (2026-06-04): graphify was evaluated as a storage/retrieval layer and
> NOT adopted.** Keep the locked vault design. This file exists so the decision
> isn't re-litigated and the landmines aren't re-hit. Spikes 015–018.

## Requirements (what the evaluation locked in)

- **graphify ≠ storage.** It is a query/extraction layer *over* a corpus that emits
  a derived `graph.json`. The markdown vault (`events.md` source of truth +
  materialized views, from spikes 006/008) stays authoritative **regardless** of any
  graph. "Migrate to graphify *instead of* Obsidian" is a category error.
- **Do NOT add a runtime graph layer** for coherence or rules retrieval. The vault
  stack (events.md + materialized views + `read_vault_multi` + curated `index.md` +
  per-turn summarization) already wins on precision, accuracy, locality, cost, and
  language-independence.
- If graphify is ever revisited, it is **batch-only, offline, developer-facing** —
  never in the turn loop — and only with a **custom narrative-relation extraction
  prompt** (the stock prompt yields useless generic edges). Prove value first.

## How It Works (the working recipe, if ever revisited)

```bash
# Install WITH the backend extra — plain `graphifyy` omits the openai dep.
uv tool install "graphifyy[ollama]"

# Build a graph from a folder (AST + semantic LLM) -> <dir>/graphify-out/graph.json
# Local backend (offline, free, but slow/unreliable — see What to Avoid):
export OLLAMA_API_KEY=ollama OLLAMA_BASE_URL=http://localhost:11434/v1
graphify extract <dir> --backend ollama --model qwen3:30b-a3b-instruct-2507-q4_K_M \
  --max-concurrency 1 --no-cluster

# Cloud-class backend (reliable, deduplicated, needed for anything real).
# claude-cli routes through the local Claude Code CLI — no API key, billed to plan:
export GRAPHIFY_CLAUDE_CLI_MODEL=sonnet
graphify extract <dir> --backend claude-cli --max-concurrency 1

# Query (LOCAL, cheap, no LLM — this side is genuinely good):
graphify query "<question>" --graph <dir>/graphify-out/graph.json --budget 1500
graphify explain "<node label>" --graph ...        # focused neighbour list
graphify path "A" "B" --graph ...                  # shortest path
```

- `update` is **code-only** (AST/tree-sitter, no LLM); narrative needs full `extract`.
- A **semantic cache** (`graphify-out/cache/semantic/`, keyed by content hash) means a
  rebuild only re-extracts changed files — helps a batch refresh, not the turn loop.
- `graph.json` stores edges under the **`links`** key (not `edges`).

## What to Avoid (landmines hit during spiking)

- **No live per-turn updates.** Re-extracting one turn's narrative on the local
  primary model took **355–425 s** (~100× the 3.78 s warm turn) and once produced
  **0 nodes** (runaway 14,930-token invalid JSON; Ollama silently ignores the output
  cap). Per-turn graph maintenance is infeasible. (Spike 015)
- **Local models are not viable for real extraction.** qwen3:30b = slow + bimodal
  reliability; gemma4:12b = 386 s and **1 node** (near-total failure). Use cloud /
  claude-cli. (Spike 016)
- **The stock extraction prompt yields 100% generic relations** on capable models
  (`references`, `conceptually_related_to`) — a co-occurrence web, never
  "who-did-what". Only the slow/unreliable local model deviated into rich relations,
  and it brought duplicates. There is **no config that gives clean nodes AND rich
  relations** out of the box. (Spikes 016/017/018)
- **Clustering does NOT dedup** cross-file duplicate nodes. A capable model dedups;
  `cluster-only` does not. (Spike 016)
- **The graph loses to a vault entity-read for coherence recall**: 8/8 vs ~3/8 gold
  facts, comparable tokens, lower latency, zero new infra for the vault. (Spike 017)
- **`query` over-retrieves** — BFS depth-2 returns ~half the graph, not a focused
  answer; gets worse as the graph grows. Results are **pointers, not content** (you
  still read the source docs). (Spikes 017/018)
- **`affected` is broken** on the `links` schema (`could not load graph: 'links'`).
- **`god nodes` / community labeling failed silently** (unnamed `Community N`, empty
  God Nodes section) on the static corpus. (Spike 018)
- **Node matching is language-coupled to the corpus.** An Italian query against an
  English handbook graph returned **0 matches**. (Spike 018)

## Constraints (hard numbers, M5 Pro — informative, not M4-decision-grade)

| Fact | Value |
|------|-------|
| Per-turn local re-extraction | 355–425 s (~100× the 3.78 s turn) |
| Local single-file failure | 14,930-token runaway → 0 nodes |
| gemma4:12b | 386 s → 1 node |
| claude-cli/Sonnet (campaign, 13 turni) | 194 s, 23 nodes, 0 dup |
| claude-cli/Sonnet (craft/, 12 docs, 4.1k tok) | 320 s, ~55k tokens, 66 nodes |
| Graph query (BFS, local) | 0.07–0.16 s, no LLM |
| Stock-prompt relation genericness (cloud) | 100% generic |

## Niche where graphify *could* help

An **offline, developer-facing** aid for exploring corpus structure during authoring:
betweenness-centrality insights (e.g. "Combat is the cross-community bridge"), the
`graph.html` / collapsible-tree viz. A dev tool — never a runtime component.

## Origin

Synthesized from spikes: 015, 016, 017, 018.
Source files in: `sources/015-graphify-update-loop-m4/`,
`sources/016-extraction-quality-and-backend/`, `sources/017-coherence-recall/`,
`sources/018-static-rules-retrieval/`. Full graph fixtures in
`.planning/spikes/{016,018}-*/fixtures/`. Phase verdict in
`.planning/spikes/MANIFEST.md`.
