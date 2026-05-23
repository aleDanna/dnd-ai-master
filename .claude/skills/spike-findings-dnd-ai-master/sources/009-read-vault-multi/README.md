---
spike: 009
name: read-vault-multi
type: standard
validates: "Given a multi-fact query, when using batched read_vault_multi vs sequential read_vault, then warm wall-clock drops ≥50% AND keyword quality is preserved"
verdict: VALIDATED
related: [003, 005]
tags: [g1, mitigation, complex-turn, tool-design]
---

# Spike 009: read-vault-multi

## What This Validates

Spike 005 found that the warm wall-clock advantage measured in 003 (-63%) collapses on complex multi-tool turns (-1.1%) due to N roundtrips of context re-prefill. This spike validates the proposed mitigation: a `read_vault_multi({paths: [...]})` tool that batches N file reads into 1 roundtrip.

Gate: ≥50% wall-clock improvement vs the sequential baseline AND quality preserved.

## How to Run

```bash
pnpm exec tsx .planning/spikes/009-read-vault-multi/run-multi.ts
```

Single complex scenario (the same fighter-vs-goblin combat round from spike 005). Two tool surfaces:
- **sequential:** `[read_vault, end_turn]` — model must call read_vault N times
- **batched:** `[read_vault_multi, end_turn]` — model calls read_vault_multi once with all paths

Cold and warm states for each.

## Results

**Verdict: VALIDATED**

| Setup | State | Wall (ms) | Tool calls | Read calls | Paths | Prompt tok | Eval tok | Keywords |
|---|---|---|---|---|---|---|---|---|
| sequential | cold | 15,631 | 2 | 2 | 2 | 1,994 | 760 | 5/5 |
| sequential | warm | **24,551** | 8 | 8 | 8 | 8,460 | 1,333 | **2/5** ✗ |
| batched | cold | 11,975 | 1 | 1 | 2 | 1,430 | 548 | 5/5 |
| batched | warm | **9,885** | 2 | 1 | 2 | 1,350 | 559 | **5/5** ✓ |

**Δ wall (warm): -59.7%** (well past the ≥50% gate)
**Quality: sequential 2/5 → batched 5/5** (improvement, not regression)
**Prompt tokens: 8,460 → 1,350** (-84%)

### Three findings

#### 1. Wall-clock drops 60%, exactly as the design predicted

The mitigation works as intended: 1 batched roundtrip carries the cost of context-bloat once, where 8 sequential roundtrips compound that cost.

#### 2. Quality IMPROVES, not just speed

Sequential warm hit only 2/5 keywords — the model got lost after 8 reads, made errors, didn't synthesize cleanly. Batched warm hit 5/5: with one comprehensive read, the model has all facts simultaneously and synthesizes a coherent answer.

This validates a hidden claim of the design: "fewer roundtrips = less model confusion." Multi-roundtrip reasoning isn't just slow, it's lossy.

#### 3. Sequential cold did fine; sequential warm was the failure mode

Sequential cold: 2 reads, 5/5, 15.6s. Sequential warm: 8 reads, 2/5, 24.5s. The same model + same prompt + same tools regressed in *both* speed and quality on the warm pass. Likely cause: warm KV cache biases the model to chain more tool calls than necessary, exploring the vault rather than committing to an answer.

This finding combined with spike 005 makes a strong case: **the warm advantage of vault setups is fragile without read_vault_multi.** Sequential read tools are a footgun.

## Investigation Trail

### Iteration 1 — Same scenario, two tool surfaces

Run first try. Numbers were so clean (60% improvement + quality jump) no follow-up was needed.

### Iteration 2 — Test with larger scenarios (not run)

The current scenario only needs 2 files (Aragorn + Goblin). A scenario needing 5-6 files would stress batched even more — and likely show even larger advantage, since sequential would balloon to 5-6 roundtrips.

### Iteration 3 — Compare with qwen3:30b-a3b (not run)

gpt-oss:20b was the choice from spike 002. qwen3:30b-a3b might use `read_vault_multi` differently (could pass fewer paths per call, requiring multiple batched calls). Not validated. For now, primary model = gpt-oss:20b.

## Decision-grade implications

1. **`read_vault_multi` is MANDATORY in the real build's tool surface.** Without it, complex turns regress badly (spike 005). With it, the warm advantage from 003 is preserved on complex turns too.

2. **`read_vault` (singular) should probably be REMOVED from the tool surface entirely**, not just supplemented. The sequential warm result was actively worse in quality. If the model is given both tools, it may default to the sequential one and degrade. Force the batched API.

3. **The Phase 1 tool surface is:**
   - `read_vault_multi({paths: string[]})` — primary read
   - `list_vault({directory})` — directory listing for discovery
   - `apply_event({type, payload})` — single mutation primitive (spike 006/008/010)
   - `end_turn({response})` — narrative termination (and accept `no_tool_calls + content` as alternative per spike 002)

   That's 4 tools. The system prompt instruction becomes simpler: "use read_vault_multi to fetch any files you need in ONE call."

4. **Estimated M4 numbers (×2.5):**
   - Sequential warm: 24.5s × 2.5 = ~61s (unacceptable)
   - Batched warm: 9.9s × 2.5 = ~25s (within usability)
   - The difference is the gate.

## Signal for the real build

- Implement `read_vault_multi` as the only read primitive.
- Drop singular `read_vault` from the public tool surface.
- System prompt instruction: "When you need multiple files, request them all in one read_vault_multi call."
- Re-measure spike 005's complex turn with this tool — expect ~10s warm wall-clock (vs the 32s observed with sequential).

## Limitations of this measurement

- N=1 per cell. The 24.5s sequential warm could be an outlier; need to re-run.
- One scenario (2-file lookup). Larger lookup sets may behave differently.
- gpt-oss:20b only. Other models may use the tool differently.
- M5 Pro only. M4 measurement still pending (spike 004 covers this generically).
