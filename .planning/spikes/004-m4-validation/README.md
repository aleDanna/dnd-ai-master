---
spike: 004
name: m4-validation
type: comparison
validates: "Given the 5 candidate models on Mac Mini M4 hardware, when running spike 002 (compliance) and spike 003 (wall-clock) on each, then identify the model(s) that pass G1 (≥40% warm wall-clock improvement) AND G2 (≥90% lenient compliance) — decision-grade for go/no-go on the vault-llm-wiki migration"
verdict: PENDING_M4
related: [002, 003]
tags: [g1, g2, m4, decision-grade, model-selection]
---

# Spike 004: m4-validation

## What This Validates

**Decision-grade G1 and G2 across the 5 candidate models on production hardware.** Spike 002 and 003 measured compliance and wall-clock on M5 Pro dev, with a small candidate pool (qwen3:30b-a3b, gpt-oss:20b, llama3.2:3b). This spike sweeps the actual production candidate pool on the Mac Mini M4 target.

Per the [target hardware memory](../../../.claude/projects/-Users-alessiodanna-projects-dnd-ai-master/memory/project_dnd_ai_master_target_hw.md), all production performance estimates for `dnd-ai-master` must use Mac Mini M4 numbers (32 GB RAM, 120 GB/s bandwidth, 256 GB SSD).

## Candidate models

| # | Model | Size on disk | Why included |
|---|---|---|---|
| 1 | `mistral-small3.2:24b-instruct-2506-q4_K_M` | ~14 GB | Explicit Q4_K_M quantization of the instruction-tuned Mistral. Often the best speed/quality tradeoff on Apple Silicon for 24B-class models. |
| 2 | `mistral-small3.2:24b` | ~14 GB | Default-tagged Mistral Small 24B. Establishes baseline for the family before isolating the quantization effect. |
| 3 | `qwen3:30b-a3b-instruct-2507-q4_K_M` | ~18 GB | Explicit Q4_K_M of the July 2026 instruction-tuned Qwen3 30B with active-3B MoE routing. Direct comparison to (4) tests quantization impact at the upper RAM bound. |
| 4 | `qwen3:30b-a3b-instruct-2507` | ~18 GB | Instruction-tuned Qwen3 30B-A3B. Tests whether the instruction-tuning of the 2507 variant improves tool-call discipline over (5). |
| 5 | `qwen3:30b-a3b` | ~18 GB | Base Qwen3 30B-A3B. The original Round-1 baseline (spike 002 measured 100% lenient compliance, 38s warm wall on M5 Pro). Anchors the M4 ratio for cross-spike calibration. |

**Notes on the M4 32 GB budget:**

- Any single 30B Q4 model (~18 GB) + nomic-embed-text (~270 MB) + macOS + Next.js + Postgres = pushing 28-30 GB. No headroom for a second loaded model. Spikes that need to swap models will pay full cold-load cost between candidates.
- The 24B Q4 models leave ~6-8 GB headroom — significantly more comfortable. If they pass compliance, they're operationally preferred on M4 even if quality is marginally lower.
- 5 candidates × ~14-18 GB each = up to ~80 GB on SSD. After macOS (~50 GB) + apps + dnd-master-plus (13 GB) + other Ollama models, this fits in 256 GB but leaves little room for growth.

## Pre-flight (one-time setup on M4)

```bash
# Pull all 5 candidates (this will take ~30-60 min and ~80 GB of SSD)
ollama pull qwen3:30b-a3b
ollama pull qwen3:30b-a3b-instruct-2507
ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M
ollama pull mistral-small3.2:24b
ollama pull mistral-small3.2:24b-instruct-2506-q4_K_M

# Build the baked baseline (required for spike 003 comparison)
pnpm build-local-models

# Verify all 6 models are present
ollama list
```

## How to Run

```bash
bash .planning/spikes/004-m4-validation/run-on-m4.sh
```

The script verifies hardware and model presence, then runs:

- **Stage 1**: spike 002 compliance sweep — 5 models × 5 scenarios × 2 reps = 50 turns
- **Stage 2**: spike 003 wall-clock comparison — 5 models × 5 scenarios × 2 setups × 2 states = 100 turns

Each candidate's logs land in `.planning/spikes/004-m4-validation/results/`:
- `compliance-m4-<model>.log`
- `walltime-m4-<model>.log`

**Stima durata totale: 2-4 ore di compute su M4** (dominata dai 30B Q4 sui complex turns). Lascia girare in background o overnight.

## Comparison templates (fill in after the run)

### Compliance table (G2 — pass ≥90% lenient)

| Model | Strict | Lenient | Finish modes | Avg wall (ms) | Avg prompt tok | Verdict |
|---|---|---|---|---|---|---|
| mistral-small3.2:24b-instruct-2506-q4_K_M | TBD | TBD | TBD | TBD | TBD | TBD |
| mistral-small3.2:24b | TBD | TBD | TBD | TBD | TBD | TBD |
| qwen3:30b-a3b-instruct-2507-q4_K_M | TBD | TBD | TBD | TBD | TBD | TBD |
| qwen3:30b-a3b-instruct-2507 | TBD | TBD | TBD | TBD | TBD | TBD |
| qwen3:30b-a3b (Round 1 baseline) | TBD | TBD | TBD | TBD | TBD | TBD |

### Wall-clock table (G1 — pass ≥40% warm improvement vs baked)

| Model (vault) | Warm baked (ms) | Warm vault (ms) | Δ wall warm | Cold vault (ms) | Quality | Verdict |
|---|---|---|---|---|---|---|
| mistral-small3.2:24b-instruct-2506-q4_K_M | TBD | TBD | TBD | TBD | TBD | TBD |
| mistral-small3.2:24b | TBD | TBD | TBD | TBD | TBD | TBD |
| qwen3:30b-a3b-instruct-2507-q4_K_M | TBD | TBD | TBD | TBD | TBD | TBD |
| qwen3:30b-a3b-instruct-2507 | TBD | TBD | TBD | TBD | TBD | TBD |
| qwen3:30b-a3b | TBD | TBD | TBD | TBD | TBD | TBD |

### Bandwidth-ratio cross-check (sanity)

Compare M4 warm wall-clock to spike 003 M5 Pro warm number (`gpt-oss:20b` vault was ~4.5 s). If the M4 ratio is ~2-2.5× (as predicted by 307→120 GB/s bandwidth), the projection is consistent. If it's much higher (e.g. 4-5×), there's an unexpected bottleneck on M4 worth investigating before committing.

## Decision logic (after run)

Pick the **single primary** model for the vault path using these gates, in order:

1. **G2 lenient compliance ≥90%.** Any model below this is eliminated. Tool discovery is non-negotiable.
2. **G1 warm wall-clock improvement ≥40%** vs `dnd-master-plus` baked baseline. Below this, the migration is not worth its complexity cost.
3. **Tie-break by absolute warm wall-clock** (lower wins). M4 production UX is sensitive — even at -50% relative, if the absolute is >30 s, the experience is rough.
4. **Tie-break by disk footprint** (smaller wins). On a 256 GB SSD, 14 GB beats 18 GB.
5. **Tie-break by `end_turn` adherence** (more = better). Spike 002 showed qwen3:30b-a3b skipped `end_turn` 40% of the time. Models that always close cleanly are preferred.

Update the Results section with the chosen primary + a documented fallback (one quality-fallback for narrative richness if compliance gates allow it).

## Results

**PENDING — run the script on Mac Mini M4 and populate the tables above.**

After the run, the verdict line should read one of:
- ✓ **VALIDATED** — `<chosen-model>` passes G1 + G2 on M4. Migration is GO.
- ⚠ **PARTIAL** — `<chosen-model>` passes G2 but G1 is X% (under 40%). Migration GO with reduced expected gain; reconsider scope.
- ✗ **INVALIDATED** — no candidate passes both gates. Migration is NO-GO until different models or design revision.

## Updates to upstream documents (apply after run)

If a new primary model is selected (not gpt-oss:20b as currently in the manifest):
- Update `.planning/spikes/MANIFEST.md` → Requirements section, "Primary local model"
- Update `docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md` → §1.5 Target hardware notes
- Update `docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md` → R1 if compliance characteristic differs

If G1 ≥40% holds on M4 → mark the gate row in MANIFEST.md as ✓ GREEN with M4 numbers, drop the "M4 measurement pending" caveat.
