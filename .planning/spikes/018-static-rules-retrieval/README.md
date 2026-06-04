---
spike: 018
name: static-rules-retrieval
type: comparison
validates: "Given a cross-cutting handbook question, when answered via graph-query vs path-deterministic vault read, then compare correctness, tokens, latency, and discovery value"
verdict: PARTIAL
related: [015, 016, 017]
tags: [graphify, static, rules, handbook, retrieval, comparison, path-deterministic]
---

# Spike 018: static-rules-retrieval (graph vs path-deterministic)

## What This Validates

Use case 1 — the static graph (rules / handbook / prompts). graphify's theoretical
sweet spot: a **static** corpus, built **once**, queried forever. The dynamic-graph
problems (per-turn updates, live coherence) don't apply.

**Given** a cross-cutting handbook question ("handling PC death in combat while
keeping tension + consequences" — spans combat / death / pacing / resolving-outcomes),
**when** answered via **(a)** a graphify query on a static graph vs **(b)** the
project's curated `index.md` + path-deterministic `read_vault_multi`,
**then** compare correctness, tokens, latency, and discovery value.

Corpus: the real `data/vault/handbook/craft/` (12 DM-technique docs, ~4.1k tokens) —
exactly what the project queries today. Graph built one-time with claude-cli/Sonnet
(best-quality backend per spike 016).

## Findings

### Build cost (one-time, but not cheap)
- `extract` (Sonnet/claude-cli): **320 s**, **26.6k in / 28.8k out tokens** for a
  4.1k-token corpus → produced **66 nodes / 96 edges / 8 communities**. Over-extracts
  (~5.5 nodes per doc, fragmenting each doc into many concept nodes). One-time, so
  acceptable, but a direct API would be needed to make it cheap/fast.

### Relations are 100% generic (again)
- 96/96 edges generic: `references` 56, `conceptually_related_to` 33,
  `semantically_similar_to` 7. Same as spike 017 — the static graph is a
  **co-occurrence web**, not "rule X modifies rule Y". No rule-interaction semantics.

### The "god nodes" / named-communities feature did not deliver
- `cluster-only --backend claude-cli` reported "Labeling communities… Done" in **0 s**
  but the report's communities are still unnamed (`Community 0`…`Community 7`), and the
  **"God Nodes" section is empty**. The headline "understand your corpus via named
  thematic hubs" output **failed silently** here.
- One genuinely useful artifact: a betweenness-centrality insight — *"Combat is a
  cross-community bridge (0.503)."* Real, but **developer-facing structural insight**,
  not runtime retrieval.

### Query works (English) but over-retrieves and returns pointers, not content
- IT query → **0 matches** (nodes are in the corpus language, English; gameplay is
  Italian). Language coupling is a real wart.
- EN query "handling PC death in combat…" → matched `Combat`, BFS depth-2 →
  **33 of 66 nodes** (half the graph). The relevant nodes are present (Death Saves,
  Lingering Injury, Narrate Consequences Not Numbers, Cliffhangers and Tension) but
  buried among ~25 irrelevant ones (Awarding XP, NPC Allies, Leveling Up…). Low precision.
- Crucially the query returns **node labels + source files (pointers), not the rule
  content** — the LLM must *still* read the source docs afterward. So the graph
  **duplicates the discovery role of the curated index**, less precisely.

## Head-to-head

| | Path-deterministic (current) | graphify static graph |
|---|---|---|
| Discovery | `index.md` 333 tok, 1 read → curated titles for all 12 docs | 33-node BFS dump (~700 tok), over-retrieves, pointers only |
| Content | reads the 4 relevant docs (~2041 tok) — authoritative, full | none — must still read the docs |
| Precision | high (curated titles, model picks) | low (half the graph) |
| Relations | n/a (reads prose) | 100% generic |
| Language | index can be any language | coupled to corpus language (IT query → 0 hits) |
| Build | already done (migration script) | 320 s + ~55k Sonnet tokens, one-time |
| Latency | ~ms file reads | 0.068 s query (then still ms file reads) |

## Results

**Verdict: ⚠ PARTIAL** — the static graph does **not** clearly beat the curated
`index.md` + path-deterministic reads. It duplicates the index's discovery role with
lower precision (over-retrieval), 100% generic relations, a broken god-nodes output,
language coupling, and a non-trivial one-time build cost — while returning pointers the
model must follow back to the same docs anyway.

**Where it has niche value:** as an **offline, developer-facing** aid — the betweenness
insight ("Combat is the bridge concept"), the `graph.html` / tree viz for exploring the
handbook's structure during authoring. A dev tool, not a runtime retrieval layer. It
would matter more for a **large, un-curated** corpus with no index — but the project
already maintains a curated index, which is the cheaper, more precise solution.

**Limitations:** one corpus (craft/, 12 docs), one cross-cutting question, one backend.
Community labeling apparently failed (possible graphify bug) — a working label pass might
add thematic-hub value, but the betweenness insight was the only structural payoff seen.
