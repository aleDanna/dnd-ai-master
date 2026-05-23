---
spike: 014
name: narrative-quality-comparison
type: comparison
validates: "Given 5 narrative-heavy D&D scenarios in Italian, when run on the 4 M4 candidate models with NO 'concise' constraint, then human evaluation identifies which model produces the most engaging prose, NPC voicing, scene description, and improvised lore"
verdict: VALIDATED
related: [002, 003, 004]
tags: [m4, narrative, qualitative, italian, human-eval, model-selection]
---

# Spike 014: narrative-quality-comparison

## What This Validates

The qualitative gap left by spikes 002-004: **narrative richness and choice quality** of the candidate models.

Prior spikes measured:
- **G1 wall-clock** (spike 003, 004)
- **G2 tool-discovery compliance** (spike 002, 004)
- **Keyword correctness** on lookup queries (all)

None measured:
- Scene description / atmosphere
- NPC voicing and dialogue
- Combat narration cinematic-ness
- Choice presentation with dramatic weight
- Lore improvisation quality
- Italian prose register (the project's primary language)

This spike fills that gap with **human judgment** as the only valid metric.

## Why this matters

Spike 004 chose `qwen3:30b-a3b-instruct-2507-q4_K_M` as primary on the basis of feasibility (G1 -85.5%, G2 100%, 3.78 s warm). Analysis of the few prose snippets in the spike-002 forensic logs showed the model has a **didactic, technical** voice (lots of `**bold**` markdown, step-by-step calculations, zero descriptive flourish) — fine for a rules lookup, possibly bland for a campaign master.

Meanwhile `qwen3:30b-a3b` BASE (the thinking variant) had the highest keyword-correctness (5/5 in spike 004) but was eliminated for 36.6 s wall-clock — yet may have a richer narrative voice if its decode time is acceptable for *narrative-only* turns.

`mistral-small3.2:24b` was eliminated for G2 (80% compliance) but is often anecdotally considered the strongest local model for evocative European-language narration.

The chosen primary might be wrong for narrative work. Better to find out now than after migration.

## Candidates

| Model | Origin | Note |
|---|---|---|
| `qwen3:30b-a3b-instruct-2507-q4_K_M` | spike 004 winner | Current "primary" — does it actually narrate well? |
| `qwen3:30b-a3b-instruct-2507` | spike 004 quality-fallback | Possibly slightly richer than q4_K_M? |
| `qwen3:30b-a3b` | spike 004 offline-only | Best keyword quality, slow — narrative voice unknown |
| `mistral-small3.2:24b` | spike 004 eliminated on G2 | Anecdotal narrative strength — sanity check |

## Scenarios (5 dimensions probed)

1. **Scene description** — torre dello stregone abbandonata di notte
2. **NPC dialogue** — vecchio mercante Bargo che nasconde qualcosa
3. **Combat narration** — critico di Aragorn su goblin (16 dmg su 7 HP, overkill)
4. **Moral choice** — bambina vs artefatto, soffitto crolla in 10 secondi
5. **Lore improvisation** — diario goblin trovato in covo

Full prompts and rubrics in `scenarios.ts`. Each forces ITALIAN output and removes the "concise" constraint.

## How to Run

**On Mac Mini M4** (all 4 candidates must be pulled):

```bash
bash .planning/spikes/014-narrative-quality/run-on-m4.sh
```

The script verifies models, runs 4 × 5 = 20 turns (~10-20 min on M4), saves:
- `results/raw-<ts>.json` — all responses + timing as JSON
- `results/comparison-<ts>.md` — side-by-side markdown report with human-verdict tables to fill

## What to Expect

- 20 LLM turns total. ~15 min on M4.
- The markdown report has, for each scenario:
  - The prompt + rubric
  - All 4 model responses verbatim
  - An empty "Human verdict" table for ranking
- At the end, an "Overall scoring" table aggregates per-scenario ranks into a primary recommendation.

## Evaluation method

**Human only.** No automated scoring. Per scenario, rank 1 (best) to 4 (worst) based on:

- Match against the rubric (per scenario)
- Italian prose quality (idioms, register, grammar)
- Voice distinctiveness (would you remember this NPC? this scene?)
- Lack of cliché (no "il silenzio inquietante", no "una pioggia di sangue")
- Show-don't-tell discipline

Aggregate ranks → choose primary for narrative-heavy turns.

## Results

**Verdict: ✓ VALIDATED — Outcome #1 (primary unchanged).**

20 turns generated on M4 + 5 retest turns of base model on M5 Pro with `think: false`. Human evaluation (Claude-assisted, user-confirmed) produced per-scenario ranks aggregated below.

### Aggregate ranks (lower = better)

| Model | S1 scene | S2 NPC | S3 combat | S4 choice | S5 lore | **Total** | Average |
|---|---|---|---|---|---|---|---|
| **qwen3:30b-a3b-instruct-2507-q4_K_M** | 1 | 2 | 1 | 2 | 3 | **9** | 1.8 |
| **qwen3:30b-a3b-instruct-2507** | 2 | 1 | 3 | 1 | 2 | **9** | 1.8 |
| mistral-small3.2:24b | 3 | 3 | 2 | 3 | 1 | 12 | 2.4 |
| qwen3:30b-a3b BASE | 4 | 4 | 4 | 4 | 4 | 20 | 4.0 |

### Findings

1. **q4_K_M and non-q4 instruct tied at 9 points** with complementary strengths:
   - q4_K_M: stronger on *sensory-cinematic* prose (scene atmosphere, combat fisicality, overkill spectacle)
   - non-q4: stronger on *narrative structure* (NPC voices with hook plot, dramatic weight in moral choices)
2. **mistral-small3.2:24b** wins ONE dimension only — *authentic goblin voice* (pidgin "Ugh, oggi capo arrabbiato", "umani vicini prendere cose"). Elsewhere conventional and cliché-prone. Useful role: offline content generation for voice-strong non-standard text.
3. **qwen3:30b-a3b BASE re-test with `think: false`** still produces unusable output — the model leaks its English chain-of-thought into the content stream instead of emitting a clean Italian final answer. Dropped from candidate pool. See Iteration 2 section of the comparison report.

### Decision (locked)

- **Primary:** `qwen3:30b-a3b-instruct-2507-q4_K_M` — unchanged from spike 004. Quality tie with non-q4 on narrative + wins on feasibility (G1 -85.5% on M4, smaller disk footprint).
- **Quality-fallback (opt-in):** `qwen3:30b-a3b-instruct-2507` — marginally stronger NPC voicing and moral-choice presentation. Δ wall-clock ~90 ms (trivial). User can switch from settings when NPC depth matters.
- **Mistral utility:** keep `mistral-small3.2:24b` as a non-default tool for offline content generation when voice-strong non-standard prose is needed (goblin scripts, draconic dialogue, ritual texts).
- **qwen3:30b-a3b base: DROPPED from candidate pool.** Without a chain-of-thought extraction pipeline (out of scope), the model is unusable for direct narrative output.
- **Tier-split NOT required at Phase 1.** Δ between q4 and non-q4 is too small to justify implementing a per-turn model router. Re-evaluate post-launch with engagement data.

## Why this is the right time to ask

After spike 004, the migration is technically GO. Before plan-phase locks in the primary, the **narrative dimension** is the last unmeasured axis. If outcome #2 or #3 above is the answer, the Phase 1 architecture has to accommodate a per-turn model router from day one — not retrofit it after.
