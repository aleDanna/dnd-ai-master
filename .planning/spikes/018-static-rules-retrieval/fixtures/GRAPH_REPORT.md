# Graph Report - /tmp/craft018  (2026-06-04)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 66 nodes · 96 edges · 8 communities
- Extraction: 69% EXTRACTED · 31% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b9eeffee`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]

## God Nodes (most connected - your core abstractions)
1. `Combat` - 15 edges
2. `Resolving Outcomes` - 11 edges
3. `Common Pitfalls` - 7 edges
4. `Pacing & Narration` - 6 edges
5. `Exploration` - 6 edges
6. `Social Interaction` - 5 edges
7. `Improvising` - 5 edges
8. `When to Call for a Roll` - 5 edges
9. `Death and Consequences` - 4 edges
10. `Time Scales` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Adjusting Difficulty Mid-Fight` --semantically_similar_to--> `Yes And Yes But`  [INFERRED] [semantically similar]
  combat.md → improvising.md
- `Monster Behavior and Goals` --semantically_similar_to--> `Three-Beat NPC`  [INFERRED] [semantically similar]
  combat.md → npcs.md
- `Calibrating Tone` --conceptually_related_to--> `Pacing & Narration`  [INFERRED]
  knowing-the-player.md → pacing.md
- `Narrate the World` --conceptually_related_to--> `Pacing & Narration`  [INFERRED]
  role.md → pacing.md
- `Adjudicate Rules` --conceptually_related_to--> `Resolving Outcomes`  [INFERRED]
  role.md → resolving-outcomes.md

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.22
Nodes (11): Fight or Flight, Yes And Yes But, Choosing Ability and Skill, Advantage and Disadvantage, Critical Hits and Misses, DC Table, Degrees of Failure, Passive Perception vs Active Roll (+3 more)

### Community 1 - "Community 1"
Cohesion: 0.22
Nodes (11): Initiative and Pacing, What to Describe, Dungeon Crawl, Exploration, Tracking Time and Resources, Travel Stages, Brevity Is a Discipline, Cliffhangers and Tension (+3 more)

### Community 2 - "Community 2"
Cohesion: 0.24
Nodes (10): Combat, Adjusting Difficulty Mid-Fight, Monster Behavior and Goals, Tracking Monster HP, Narrate Consequences Not Numbers, Death Consequences, Death and Consequences, Death Saves (+2 more)

### Community 3 - "Community 3"
Cohesion: 0.25
Nodes (9): Common Pitfalls, GMPC-ing, Hidden-Mandatory Information, Drifting Numerical Honesty, Over-Rolling, Punishing Engagement, Railroading, Hidden Things in Adventures (+1 more)

### Community 4 - "Community 4"
Cohesion: 0.28
Nodes (9): Engagement Profiles, Knowing the Player, Calibrating Tone, Three-Beat NPC, NPC Attitude, Letting NPCs Refuse, NPC Voice and Mannerism, Roleplay First Dice Second (+1 more)

### Community 5 - "Community 5"
Cohesion: 0.29
Nodes (7): Improvising Answers, Improvised Damage Table, Improvising, Saying No, NPC Allies, NPC Names, NPCs

### Community 6 - "Community 6"
Cohesion: 0.40
Nodes (5): Awarding XP, Character Advancement, Leveling Up, XP vs Milestone, Repeating Yourself

### Community 7 - "Community 7"
Cohesion: 0.50
Nodes (4): Adjudicate Rules, Narrate the World, Surprise the Player, Your Role

## Knowledge Gaps
- **5 isolated node(s):** `Choosing Ability and Skill`, `Dungeon Crawl`, `Tracking Monster HP`, `Stabilization`, `XP vs Milestone`
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Combat` connect `Community 2` to `Community 0`, `Community 1`, `Community 4`, `Community 5`, `Community 6`?**
  _High betweenness centrality (0.503) - this node is a cross-community bridge._
- **Why does `Resolving Outcomes` connect `Community 0` to `Community 3`, `Community 7`?**
  _High betweenness centrality (0.281) - this node is a cross-community bridge._
- **Why does `When to Call for a Roll` connect `Community 3` to `Community 0`, `Community 2`, `Community 4`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `Combat` (e.g. with `Leveling Up` and `Improvised Damage Table`) actually correct?**
  _`Combat` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `Pacing & Narration` (e.g. with `Calibrating Tone` and `Narrate the World`) actually correct?**
  _`Pacing & Narration` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `Exploration` (e.g. with `Passive Perception vs Active Roll` and `Perception vs Investigation`) actually correct?**
  _`Exploration` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Choosing Ability and Skill`, `Dungeon Crawl`, `Tracking Monster HP` to the rest of the system?**
  _5 weakly-connected nodes found - possible documentation gaps or missing edges._