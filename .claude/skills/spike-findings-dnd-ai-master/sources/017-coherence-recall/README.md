---
spike: 017
name: coherence-recall
type: comparison
validates: "Given a callback to an NPC from many turns ago, when recalling its context via graph-query vs vault entity-read, then compare completeness, tokens, latency, infra cost"
verdict: INVALIDATED
related: [015, 016, 008, 009]
tags: [graphify, coherence, retrieval, query, vault, comparison]
---

# Spike 017: coherence-recall (graph-query vs vault-read)

## What This Validates

The user's headline goal for use-case 2: *"if an NPC mentioned 30 turns ago is
referenced, the LLM can read the graph to recover exactly the context."*

**Given** a callback to an NPC introduced early (Borin, turno 2),
**when** the model recovers that NPC's context via **(a)** graphify query on the
batch-built graph vs **(b)** a vault entity-file read (`read_vault_multi`),
**then** compare completeness, tokens injected, latency, and infra cost.

Uses the clean Sonnet graph from spike 016 (`016-.../fixtures/graph-sonnet.json`)
as the realistic batch-built index, and a materialized `borin-barbabronzea.md`
(the events→frontmatter projection from spike 008) as the vault entity view.

## Method

- Ran `query`, `explain`, `path`, `affected` against the Sonnet graph (timed).
- Wrote the materialized vault entity file; measured its tokens (tiktoken).
- Scored each against 8 "gold" facts about Borin: nano fabbro di Pietralba;
  nipote Pip (rapito→liberato); donò l'Amuleto a Lyra; Amuleto protegge da Vossk;
  forgiò una lama per Thorne; rivelò Spada=chiave di Kar'Doth; rivelò Vossk cerca
  la Gemma; seconda chiave al Tempio di Myrkul.

## Findings

### Graph queries are fast but retrieval quality is weak
- `query` (BFS depth=2) returned **21 of 23 nodes** — nearly the whole graph, no
  focused answer. On a large campaign graph the blast radius only grows.
- `explain Borin` is the best primitive: a focused 7-neighbour summary (~142 tok,
  0.075 s) — but see relations below.
- `path Borin → Gemma` routes through the generic hub node "I Cercatori dell'Alba".
- `affected "Negromante Vossk"` **errored**: `could not load graph: 'links'` — the
  reverse-traversal command is broken on this graph format (graphify bug/wart).

### The killer: the clean (cloud) graph has 100% generic relations
Edge-relation distribution:

| Graph | Nodes | Edges | Relations |
|-------|-------|-------|-----------|
| Sonnet (cloud, 0 dup) | 23 | 42 | **100% generic** — `references` 30, `conceptually_related_to` 11, `semantically_similar_to` 1 |
| qwen3:30b (local) | 19 | 34 | **77% rich** — `kidnapped_by`, `obedient_to`, `protects_from`, `seeks`, `reveals`, `given_to`, `key_to`, `forged`… (23% generic) |

graphify's extraction prompt ships a **code-oriented relation vocabulary**
(`calls|implements|references|cites|conceptually_related_to|shares_data_with|
semantically_similar_to`). A model that *follows* it (Sonnet) emits generic
"references" edges that say Borin is *connected to* Pip/Amuleto/Spada but never the
**nature** (nephew? gave? forged? revealed?). A model that *deviates* (local qwen)
invents narrative relations but brings duplicates + unreliability (015/016). There
is **no configuration that yields clean nodes AND rich relations** out of the box —
rich narrative edges would need a **custom extraction prompt** (real engineering cost).

### Head-to-head: recall Borin's context

| Metric | Vault read (`borin.md`) | Graph `explain` | Graph `query` |
|--------|------------------------|-----------------|---------------|
| Tokens injected | 211 | ~142 | ~890 (dump) |
| Latency | ~1 ms (file read) | 0.075 s | 0.081 s |
| Completeness (8 gold facts) | **8/8** | ~3/8 (entities only) | noise, no synthesis |
| Accuracy | high — deterministic projection of `events.md` | medium — generic edges | low |
| Relation semantics | full prose | 100% generic (Sonnet) | generic |
| New infra | **none** (already in locked design) | cloud batch build + dedup + custom prompt | same |

## Results

**Verdict: ✗ INVALIDATED** — for the headline use case, a graphify query does **not**
beat the existing vault entity-file read. The vault read (materialized view, spike
008) is **more complete (8/8 vs ~3/8), more accurate (deterministic), comparable in
tokens, lower latency, and needs zero new infrastructure.**

The graph's theoretical edge — relational / multi-hop recall — **did not materialize**:
- the clean cloud graph's relations are 100% generic (no "who did what to whom"),
- BFS `query` over-retrieves instead of answering,
- `affected` is broken,
- and the only graph with rich relations is the slow/unreliable/duplicated local one.

**Net for use case 2 (dynamic campaign graph):** combined with 015 (no live updates →
batch only) and 016 (batch needs a cloud backend), the dynamic graph is **high cost
for marginal-to-negative value** versus the already-validated vault stack
(`events.md` + materialized views + `read_vault_multi` + per-turn summarization).
**Recommendation: do not adopt a dynamic per-campaign graph.** Keep coherence on the
vault; if cross-entity relational queries are ever wanted, revisit with a custom
narrative extraction prompt and prove value first.

**Limitations:** one NPC, one campaign (13 turns); the vault file is hand-written but
faithfully mirrors what the spike-008 projector produces deterministically. A custom
extraction prompt was not built — it's noted as the only path that *might* close the
relation-semantics gap, at non-trivial cost.

**Impact:** 018 (static rules) is now the last open question and the only remaining
place graphify might earn its keep — a one-time static build, where even associative
"references" edges could help surface related rules. Same generic-relation caveat applies.
