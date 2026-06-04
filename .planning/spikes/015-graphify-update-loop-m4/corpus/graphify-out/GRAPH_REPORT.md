# Graph Report - corpus  (2026-06-04)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 19 nodes · 29 edges · 4 communities (3 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c389a410`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]

## God Nodes (most connected - your core abstractions)
1. `Cercatori dell'Alba` - 10 edges
2. `Borin Barbabronzea` - 5 edges
3. `Rovine di Kar'Doth` - 5 edges
4. `Negromante Vossk` - 5 edges
5. `I Cercatori dell'Alba` - 5 edges
6. `Goblin Clan Grenthar` - 4 edges
7. `Pip` - 3 edges
8. `Spada Fiammaluce` - 3 edges
9. `Gemma del Crepuscolo` - 3 edges
10. `Rovine di Kar'Doth` - 3 edges

## Surprising Connections (you probably didn't know these)
- `Borin Barbabronzea` --offers_help--> `Cercatori dell'Alba`  [EXTRACTED]
  events.md → events.md  _Bridges community 0 → community 2_

## Import Cycles
- None detected.

## Communities (4 total, 1 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.39
Nodes (8): Amuleto di Selûne, Cercatori dell'Alba, Foresta di Vethelorn, Goblin Clan Grenthar, Negromante Vossk, Pip, Tempio di Myrkul, Villaggio di Pietralba

### Community 1 - "Community 1"
Cohesion: 0.47
Nodes (6): Gemma del Crepuscolo, Lyra, I Cercatori dell'Alba, Rovine di Kar'Doth, Thorne, Villaggio di Pietralba

### Community 2 - "Community 2"
Cohesion: 0.83
Nodes (4): Borin Barbabronzea, Gemma del Crepuscolo, Rovine di Kar'Doth, Spada Fiammaluce

## Knowledge Gaps
- **5 isolated node(s):** `Villaggio di Pietralba`, `Locanda Il Martello Spento`, `Tempio di Myrkul`, `Lyra`, `Thorne`
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Cercatori dell'Alba` connect `Community 0` to `Community 2`?**
  _High betweenness centrality (0.216) - this node is a cross-community bridge._
- **Why does `Negromante Vossk` connect `Community 0` to `Community 2`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **What connects `Villaggio di Pietralba`, `Locanda Il Martello Spento`, `Tempio di Myrkul` to the rest of the system?**
  _5 weakly-connected nodes found - possible documentation gaps or missing edges._