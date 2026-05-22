---
spike: 004
name: m4-validation
type: standard
validates: "Given the spike 002 + 003 setups, when re-run on Mac Mini M4 hardware, then G1 ≥40% warm AND G2 ≥90% lenient still hold — decision-grade for go/no-go on the migration"
verdict: PENDING_M4
related: [002, 003]
tags: [g1, g2, m4, decision-grade]
---

# Spike 004: m4-validation

## What This Validates

**Decision-grade G1 and G2.** Spike 002 and 003 measured compliance and wall-clock on M5 Pro dev. Per the [target hardware memory](../../../.claude/projects/-Users-alessiodanna-projects-dnd-ai-master/memory/project_dnd_ai_master_target_hw.md), all production performance estimates for dnd-ai-master must use Mac Mini M4 numbers. This spike re-runs the two kill-risk benchmarks on M4 and reports the actual gate verdicts.

## How to Run

**Must be executed on a Mac Mini M4** (10-core CPU, 32GB RAM, 120 GB/s bandwidth). Ensure Ollama is installed and `gpt-oss:20b`, `dnd-master-plus:latest`, `qwen3:30b-a3b`, `llama3.2:3b` are pulled.

```bash
# Pull required models (if not present):
ollama pull gpt-oss:20b
ollama pull qwen3:30b-a3b
ollama pull llama3.2:3b
# dnd-master-plus is a baked variant — must be built from this repo on M4:
# pnpm build-local-models

bash .planning/spikes/004-m4-validation/run-on-m4.sh
```

The wrapper re-runs spike 002 (compliance) and spike 003 (wall-clock), saving logs to `.planning/spikes/004-m4-validation/results/`.

## What to Expect

- `compliance-m4.log` — the full output of spike 002 on M4
- `walltime-m4.log` — the full output of spike 003 on M4
- Comparison numbers below (to be filled after the run)

## Investigation Trail

### Iteration 1 — Not yet run on M4

This spike is PENDING. The artifacts (script, README, expected comparison) are prepared. Run the script on the Mac Mini M4 and update the Results section.

### Comparison template (fill after M4 run)

| Metric | M5 Pro (measured) | M4 (measured) | Bandwidth ratio (307/120 = 2.56) | Verdict |
|---|---|---|---|---|
| G1 warm wall-clock improvement | -63.1% | TBD | n/a (this is the actual gate) | ≥40% = PASS |
| G1 cold wall-clock improvement | -5.6% | TBD | n/a | informative |
| G2 lenient compliance gpt-oss:20b | 100% (10/10) | TBD | n/a (HW-agnostic) | ≥90% = PASS |
| G2 lenient compliance qwen3:30b-a3b | 100% (10/10) | TBD | n/a | informative |
| Avg warm wall-clock gpt-oss:20b vault | 4,502 ms | TBD | predicted 11,000-12,000 ms | M4 must be < 30s for usability |
| Avg warm wall-clock dnd-master-plus baked | 12,187 ms | TBD | predicted 30,000-31,000 ms | comparison baseline |

## Results

**PENDING — run `bash run-on-m4.sh` on Mac Mini M4 and populate this section.**

After running, the decision is:

- **G1 warm ≥40% on M4** → migration is GO
- **G1 warm < 40% on M4** → migration is reconsidered (possibly cold-start tuning, possibly abandoned)
- **G2 lenient compliance < 90% on M4** → tool discovery design must be revised (e.g., fallback to TOOL_CONTRACT_SLIM inline)

## Why this matters

The M5 Pro decode rate measured in spike 003 was ~82 tok/s. M4 with 120 GB/s vs 307 GB/s bandwidth → ~32-40 tok/s expected for the same model. Both setups (baked and vault) scale by the same factor, so the *ratio* should hold — but the absolute wall-clock numbers move into "real production UX" territory (15-30s per warm turn on vault), which is the actual user experience.

If M4 wall-clock warm > 30s for vault, the migration's user-facing benefit may not feel decisive, even at -60% relative improvement.
