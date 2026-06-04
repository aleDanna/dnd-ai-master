---
spike: 016
name: extraction-quality-and-backend
type: comparison
validates: "Given Italian D&D narrative, when graphify extracts the campaign graph, then entities/relations are captured faithfully AND a reliable backend exists for a batch build"
verdict: VALIDATED
related: [015, 014]
tags: [graphify, extraction, quality, backend, ollama, claude-cli, italian, batch]
---

# Spike 016: extraction-quality-and-backend

## What This Validates

**Given** Italian D&D narrative (the spike-015 corpus, 13 turns),
**when** graphify runs semantic extraction,
**then** the resulting graph is **faithful** to the narrative (right entities,
right relations) **and** there exists a **reliable backend** for a batch build.

Reframed after spike 015 invalidated live per-turn updates: the graph is a
**batch projection**, so this spike asks "is the projected graph trustworthy, and
what does it take to build it reliably?" — not "is it fast enough per turn."

## Investigation Trail

### 1. Faithfulness of the local qwen3:30b graph (free — analysed 015's output)
Surprisingly good. 19 nodes captured every major entity (Borin, Pip, Grenthar,
Vossk, Lyra, Thorne, all locations + items). Edges used **domain-appropriate
relations the model invented** beyond the code-ish prompt vocabulary:
`kidnapped_by`, `obedient_to`, `resides_in`, `seeks`, `protects_from`, `key_to`,
`rescues`, `forged`. Spot-check vs narrative:
- ✓ Pip→kidnapped_by→Grenthar; Grenthar→obedient_to→Vossk; Vossk→seeks→Gemma;
  Amuleto→protects_from→Vossk; Spada→key_to→Kar'Doth; Vossk→resides_in→Kar'Doth.
- ✗ **1 factual error**: `Borin→forged→Spada Fiammaluce` (the sword was inherited
  from Thorne's father; Borin forged a *new* blade). A conflation.
- ⚠ 1 over-generalisation: Amuleto `given_to` "Cercatori" instead of Lyra.
- ⚠ **3 duplicate nodes** (Gemma / Kar'Doth / Pietralba each ×2) — one from
  `index.md`, one from `events.md`. Node ID is `{stem}_{entity}`, so the same
  entity in two files becomes two nodes.

### 2. Does clustering dedup the duplicates? (free — no LLM)
**No.** `graphify cluster-only --no-label` found 4 communities but left all 19
nodes and all 3 duplicate labels. Clustering groups; it does not merge same-label
nodes across files. Out-of-the-box local extraction leaves duplicates → would need
granular single-source-per-entity inputs or a dedicated dedup pass.

### 3. Is a smaller/faster local model viable? — gemma4:12b
**No, worse on every axis.** 386 s (not faster than qwen's 425 s) and produced
**1 node / 1 edge** — near-total failure. No small local model rescues speed.

### 4. Is a cloud backend viable? — claude-cli (Sonnet, no API key, uses Claude Code auth)
**Yes — best result.** 194 s, **23 nodes / 42 edges, 0 duplicates**. Richer and
cleaner than local: disambiguated labels ("Lyra (Maga Elfa)", "Borin Barbabronzea
(Fabbro Nano)", "Pip (Nipote di Borin)"), captured the turn-13 NPC Ysolde, the
Sigillo Nero di Vossk, both keys, the Accampamento Goblin. It **unified entities
across files itself** — solving the dedup problem the local path couldn't. The
194 s includes `claude -p` subprocess/session overhead; a **direct API backend
(gemini/openai) would be materially faster** (no CLI spin-up).

## Backend comparison (head-to-head)

| Backend | Wall-clock | Nodes | Dupes | Quality | Verdict |
|---------|-----------|-------|-------|---------|---------|
| local `qwen3:30b-a3b` | 425 s | 19 | 3 | good, 1 error | slow + sometimes unreliable (015) |
| local `gemma4:12b-mlx` | 386 s | 1 | — | failed | ✗ non-viable |
| **`claude-cli` (Sonnet)** | **194 s** | **23** | **0** | **excellent** | ✓ **WINNER for batch** |

(Cost: claude-cli is billed to the Claude plan, not metered here. A direct
gemini/openai key would be cheaper per token and faster.)

## Results

**Verdict: ✓ VALIDATED (with a backend caveat).**

- **The projected graph IS trustworthy.** Faithful entity + relation capture from
  Italian narrative, with domain-appropriate edge types. The "can we trust a
  graphify campaign graph?" question is **yes**.
- **But it needs a cloud-class model.** Local models fail the reliability bar:
  qwen3:30b is slow + occasionally produces 0 nodes; gemma4:12b is non-viable.
  A capable model (Sonnet via claude-cli, or a direct gemini/openai key) gives a
  clean, **dedup'd**, richer graph.
- **Dedup is a model-quality property here**, not a graphify post-step — the strong
  model unified cross-file entities; local + clustering did not.

**Design implications:**
- **Use case 1 (static rules graph): clean fit.** A static corpus is extracted
  **once** (cloud), shipped as `graph.json`, then queried **locally/free** forever
  (0.16 s BFS, spike 015). No ongoing cloud dependency. → carries into 018.
- **Use case 2 (dynamic campaign graph): viable but with a concession.** A batch
  rebuild needs either a **cloud/claude-cli extraction** (introduces a cloud
  dependency into a deliberately local/offline project) **or** coarse ~7-min local
  batches at session boundaries accepting lower quality + a dedup pass. The vault
  stays the local source of truth either way.

**Limitations:** single corpus (13 turns), single run per backend (no variance
across runs — local qwen reliability is bimodal: 015 saw both a 19-node success and
a 0-node failure). Quality judged by author inspection (Italian), not a formal rubric.

**Impact on remaining spikes:** 017 (coherence recall) uses the **clean Sonnet
graph** (`fixtures/graph-sonnet.json`) as the realistic batch-built index to test
graph-query vs vault-read. 018 (static rules) is now the strongest candidate —
one-time cloud build, local queries.
